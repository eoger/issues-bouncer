/*eslint-env node*/

var P = require("bluebird");
var GitHubApi = require("github");
var config = require("./config");
var argv = require("yargs").argv;

function main() {
  "use strict";

  var seconds = config.days_before_unassign * 24 * 3600 * 1000;
  var dateThreshold = new Date(new Date().getTime() - seconds);

  var github = P.promisifyAll(new GitHubApi({
      version: "3.0.0",
      protocol: "https",
      timeout: config.requests_timeout
  }));
  var githubIssues = P.promisifyAll(github.issues);

  github.authenticate({
      type: "basic",
      username: config.github_user,
      password: config.github_token
  });

  var pullRequests = [];

  function isIssueMentioned (obj, issueNumber) {
    var action = "((Fix(e(s|d))?)|((Close|Resolve)(s|d)?)) ";
    var issueNumberReg = new RegExp(action + "#" + issueNumber, "i");
    var issueUrlReg = new RegExp(action +
      "https?:\/\/github.com\/" + config.github_repo_owner + "\/" +
      config.github_repo_name + "\/issues\/" + issueNumber, "i");

    return issueNumberReg.test(obj.body) || issueUrlReg.test(obj.body);
  }

  function hasRelatedPR (issueNumber) {
    return pullRequests.some(function (pr) {
      return isIssueMentioned(pr, issueNumber) || pr.comments.some(function (comment) {
        return isIssueMentioned(comment, issueNumber);
      });
    });
  }

  function concatNextPages (curPage, acc) {
    acc = acc || [];
    acc = acc.concat(curPage);
    if(github.hasNextPage(curPage)) {
      return github.getNextPageAsync(curPage)
        .then(function(nextPage) {
          return concatNextPages(nextPage, acc);
        });
    }
    else {
      return acc;
    }
  }

  function fetchIssueEvents (issue) {
    return githubIssues.getEventsAsync({
      user: config.github_repo_owner,
      repo: config.github_repo_name,
      number: issue.number
    })
    .then(concatNextPages);
  }

  function fetchIssueComments (issue) {
    return githubIssues.getCommentsAsync({
      user: config.github_repo_owner,
      repo: config.github_repo_name,
      number: issue.number
    })
    .then(concatNextPages);
  }

  function findLastAssignment (issue) {
    var lastAssignment;
    issue.events.reverse().some(function (event) {
      if (event.event === "assigned") {
        lastAssignment = new Date(event.created_at);
        return true;
      }
    });
    return lastAssignment;
  }

  function findLastBouncerComment (issue) {
    var lastComment;
    issue.comments.reverse().some(function (comment) {
      if (comment.user.login === config.github_user) {
        lastComment = new Date(comment.created_at);
        return true;
      }
    });
    return lastComment;
  }

  function warningMessage (assignee) {
    return "Hey @" + assignee + ", you have been assigned on this issue for more than "
           + config.days_before_unassign + " days!\n" +
           "Maybe you should consider un-assigning yourself and let other people try to solve this issue.";
  }

  function unassignMessage (assignee) {
    return "Sorry @" + assignee + " you have been assigned on this issue for" +
           " more than " + config.days_before_unassign + " days!";
  }

  function commentIssue (issue, commentOnly) {
    return githubIssues.createCommentAsync({
      user: config.github_repo_owner,
      repo: config.github_repo_name,
      number: issue.number,
      body: commentOnly ? warningMessage(issue.assignee.login) :
                          unassignMessage(issue.assignee.login)
    });
  }

  function unassignIssue (issue) {
    return githubIssues.editAsync({
      user: config.github_repo_owner,
      repo: config.github_repo_name,
      number: issue.number,
      assignee: ""
    });
  }

  /*eslint camelcase: [2, {properties: "never"}]*/
  githubIssues.repoIssuesAsync({
    user: config.github_repo_owner,
    repo: config.github_repo_name,
    per_page: "100",
    state: "all"
  })
  .then(concatNextPages)
  .then(function filterUnassignedIssues (issues) {
    return issues.filter(function (issue) {
      return issue.pull_request
             || (issue.assignee !== null && issue.state === "open");
    });
  })
  .then(function fetchComments (issues) {
    return P.map(issues, function (issue) {
      return fetchIssueComments(issue)
      .then(function (comments) {
        issue.comments = comments;
        return issue;
      });
    });
  })
  .then(function separatePRs (issues) {
    return issues.filter(function (issue) {
      var isPR = issue.pull_request !== undefined;
      if(isPR) {
        pullRequests.push(issue);
      }
      return !isPR;
    });
  })
  .then(function fetchEvents (issues) {
    return P.map(issues, function (issue) {
      return fetchIssueEvents(issue)
      .then(function (events) {
        issue.events = events;
        return issue;
      });
    });
  })
  .then(function filterStaleIssues (issues) {
    return issues.filter(function (issue) {
      var lastAssignment = findLastAssignment(issue);
      if (lastAssignment > dateThreshold) {
        return false;
      }

      var lastBouncerComment = findLastBouncerComment(issue);
      if (lastBouncerComment && lastBouncerComment > dateThreshold) {
        return false;
      }

      if (hasRelatedPR(issue.number)) {
        return false;
      }

      return true;
    });
  })
  .then(function (issues) {
    P.each(issues, function unassign (issue) {
      console.log("Bouncing https://github.com/" + config.github_repo_owner +
                  "/" + config.github_repo_name + "/issues/" + issue.number);

      var actions;
      if (argv.dryrun) {
        actions = true;
      }
      else {
        actions = commentIssue(issue, argv.noedit);
        if (!argv.noedit) {
          actions.then(unassignIssue);
        }
      }
      return actions;

    });
  })
  .then(function () {
    console.log("Done!");
  });
}

main();
