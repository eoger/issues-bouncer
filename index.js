/*eslint-env node*/

var P = require("bluebird");
var GitHubApi = require("github");
var config = require("./config");
var argv = require('yargs').argv;

function main() {
  "use strict";

  var seconds = config.days_before_unassign * 24 * 3600 * 1000;
  var dateThreshold = new Date(new Date().getTime() - seconds);

  var github = P.promisifyAll(new GitHubApi({
      version: "3.0.0",
      protocol: "https",
      timeout: 10000
  }));
  var githubIssues = P.promisifyAll(github.issues);

  var pullRequests = [];

  github.authenticate({
      type: "basic",
      username: config.github_user,
      password: config.github_token
  });

  function hasRelatedPR (issueNumber) {
    return pullRequests.some(function (pr) {
      var issueRef = new RegExp("((Fix(e(s|d))?)|((Close|Resolve)(s|d)?)) #" +
        issueNumber, "i");
      return issueRef.test(pr.body);
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

  function unassignMessage (assignee) {
    return "Sorry @" + assignee + " you have been assigned on this issue for" +
    " more than " + config.days_before_unassign + " days!";
  }

  /*eslint camelcase: [2, {properties: "never"}]*/
  githubIssues.repoIssuesAsync({
    user: config.github_repo_owner,
    repo: config.github_repo_name,
    per_page: "100"
  })
  .then(concatNextPages)
  .then(function filterIssues (issues) {
    return issues.filter(function (issue) {
      if(issue.pull_request) {
        pullRequests.push(issue);
        return false;
      }
      return issue.assignee !== null;
    });
  })
  .then(function fetchEvents (issues) {
    return P.map(issues, function (issue) {
      return fetchIssueEvents(issue)
      .then(function (events) {
        return {
          number: issue.number,
          assignee: issue.assignee.login,
          events: events
        };
      });
    });
  })
  .then(function filterStaleIssues (issues) {
    return issues.filter(function (issue) {
      var lastAssignment;
      issue.events.some(function (event) {
        if (event.event === "assigned") {
          lastAssignment = new Date(event.created_at);
          return true;
        }
      });
      return lastAssignment < dateThreshold
             && !hasRelatedPR(issue.number);
    });
  })
  .then(function (issues) {
    P.each(issues, function unassign (issue) {
      console.log("Bouncing https://github.com/" + config.github_repo_owner +
                  "/" + config.github_repo_name + "/issues/" + issue.number);

      if (argv.dryrun) {
        return true;
      }

      return githubIssues.editAsync({
        user: config.github_repo_owner,
        repo: config.github_repo_name,
        number: issue.number,
        assignee: ""
      })
      .then(function addComment () {
        return githubIssues.createCommentAsync({
          user: config.github_repo_owner,
          repo: config.github_repo_name,
          number: issue.number,
          body: unassignMessage(issue.assignee)
        });
      });
    });
  })
  .then(function () {
    console.log("Done!");
  });
}

main();
