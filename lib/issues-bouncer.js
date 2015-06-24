var P = require("bluebird");
var GitHubApi = require("github");

module.exports = function () {
  "use strict";

  function propertyOrError (hash, name) {
    if (hash[name] === undefined) {
      throw new Error("Missing " + name + " option value!");
    }
    else {
      return hash[name];
    }
  }

  function IssuesBouncer (options) {
    this.options = options || {};
    this.githubUser = propertyOrError(this.options, "githubUser");
    this.githubToken = propertyOrError(this.options, "githubToken");
    this.githubRepoOwner = propertyOrError(this.options, "githubRepoOwner");
    this.githubRepoName = propertyOrError(this.options, "githubRepoName");
    this.dryRun = this.options.dryRun || false;
    this.commentOnly = this.options.commentOnly || false;
    this.daysBeforeUnassign = this.options.daysBeforeUnassign || 14;
    this.requestsTimeout = this.options.requestsTimeout || 5000;
    this.issuesPerPage = this.options.issuesPerPage || 100;
    this.init();
  }

  IssuesBouncer.prototype.concatNextPages = function (curPage, acc) {
    var self = this;
    acc = acc || [];
    acc = acc.concat(curPage);
    if(self.github.hasNextPage(curPage)) {
      return self.github.getNextPageAsync(curPage)
        .then(function(nextPage) {
          return self.concatNextPages(nextPage, acc);
        });
    }
    else {
      return acc;
    }
  };

  IssuesBouncer.prototype.fetchAllIssues = function () {
    /*eslint camelcase: [2, {properties: "never"}]*/
    return this.githubIssues.repoIssuesAsync({
      user: this.options.githubRepoOwner,
      repo: this.options.githubRepoName,
      per_page: this.issuesPerPage,
      state: "all"
    });
  };

  IssuesBouncer.prototype.fetchIssuesEvents = function (issues) {
    var self = this;
    return P.map(issues, function (issue) {
      return self.fetchIssueEvents(issue)
      .then(function (events) {
        issue.events = events;
        return issue;
      });
    });
  };

  IssuesBouncer.prototype.fetchIssueEvents = function (issue) {
    return this.githubIssues.getEventsAsync({
      user: this.options.githubRepoOwner,
      repo: this.options.githubRepoName,
      number: issue.number
    })
    .then(this.concatNextPages.bind(this));
  };

  IssuesBouncer.prototype.fetchIssuesComments = function (issues) {
    var self = this;
    return P.map(issues, function (issue) {
      return self.fetchIssueComments(issue)
      .then(function (comments) {
        issue.comments = comments;
        return issue;
      });
    });
  };

  IssuesBouncer.prototype.fetchIssueComments = function (issue) {
    return this.githubIssues.getCommentsAsync({
      user: this.options.githubRepoOwner,
      repo: this.options.githubRepoName,
      number: issue.number
    })
    .then(this.concatNextPages.bind(this));
  };

  IssuesBouncer.prototype.warningMessage = function (assignee) {
    return "Hey @" + assignee + ", you have been assigned on this issue for more than "
           + this.options.daysBeforeUnassign + " days!\n" +
           "Maybe you should consider un-assigning yourself and let other people try to solve this issue.";
  };

  IssuesBouncer.prototype.unassignMessage = function (assignee) {
    return "Sorry @" + assignee + " you have been assigned on this issue for" +
           " more than " + this.options.daysBeforeUnassign + " days!";
  };

  IssuesBouncer.prototype.commentIssue = function (issue) {
    return this.githubIssues.createCommentAsync({
      user: this.options.githubRepoOwner,
      repo: this.options.githubRepoName,
      number: issue.number,
      body: this.commentOnly ? this.warningMessage(issue.assignee.login) :
                               this.unassignMessage(issue.assignee.login)
    });
  };

  IssuesBouncer.prototype.unassignIssue = function (issue) {
    return this.githubIssues.editAsync({
      user: this.options.githubRepoOwner,
      repo: this.options.githubRepoName,
      number: issue.number,
      assignee: ""
    });
  };

  IssuesBouncer.prototype.separatePRs = function (issues) {
    var self = this;
    return issues.filter(function (issue) {
      var isPR = issue.pull_request !== undefined;
      if(isPR) {
        self.pullRequests.push(issue);
      }
      return !isPR;
    });
  };

  IssuesBouncer.prototype.isIssueMentioned = function (obj, issueNumber) {
    var action = "((Fix(e(s|d))?)|((Close|Resolve)(s|d)?)) ";
    var issueNumberReg = new RegExp(action + "#" + issueNumber, "i");
    var issueUrlReg = new RegExp(action +
      "https?:\/\/github.com\/" + this.options.githubRepoOwner + "\/" +
      this.options.githubRepoName + "\/issues\/" + issueNumber, "i");

    return issueNumberReg.test(obj.body) || issueUrlReg.test(obj.body);
  };

  IssuesBouncer.prototype.hasRelatedPR = function (issueNumber) {
    var self = this;
    return self.pullRequests.some(function (pr) {
      return self.isIssueMentioned(pr, issueNumber) || pr.comments.some(function (comment) {
        return self.isIssueMentioned(comment, issueNumber);
      });
    });
  };

  IssuesBouncer.prototype.findLastAssignment = function (issue) {
    var lastAssignment;
    issue.events.reverse().some(function (event) {
      if (event.event === "assigned") {
        lastAssignment = new Date(event.created_at);
        return true;
      }
    });
    return lastAssignment;
  };

  IssuesBouncer.prototype.findLastBouncerComment = function (issue) {
    var self = this;
    var lastComment;
    issue.comments.reverse().some(function (comment) {
      if (comment.user.login === self.options.githubUser) {
        lastComment = new Date(comment.created_at);
        return true;
      }
    });
    return lastComment;
  };

  IssuesBouncer.prototype.filterStaleIssues = function (issues) {
    var self = this;
    return issues.filter(function (issue) {
      var lastAssignment = self.findLastAssignment(issue);
      if (lastAssignment > self.dateThreshold) {
        return false;
      }

      var lastBouncerComment = self.findLastBouncerComment(issue);
      if (lastBouncerComment && lastBouncerComment > self.dateThreshold) {
        return false;
      }

      if (self.hasRelatedPR(issue.number)) {
        return false;
      }

      return true;
    });
  };

  IssuesBouncer.prototype.filterUnassignedIssues = function (issues) {
    return issues.filter(function (issue) {
      return issue.pull_request
             || (issue.assignee !== null && issue.state === "open");
    });
  };

  IssuesBouncer.prototype.takeActions = function (issues) {
    var self = this;
    return P.each(issues, function unassign (issue) {
      console.log("Bouncing https://github.com/" + self.options.githubRepoOwner +
                  "/" + self.options.githubRepoName + "/issues/" + issue.number);

      var actions;
      if (self.dryRun) {
        actions = true;
      }
      else {
        actions = self.commentIssue(issue);
        if (!self.commentOnly) {
          actions.then(function () {
            return self.unassignIssue(issue);
          });
        }
      }
      return actions;

    });
  };

  IssuesBouncer.prototype.onStart = function () {
    console.log("Issue Bouncer started, please be patient!");
    return P.resolve(true);
  };

  IssuesBouncer.prototype.onFinish = function (issues) {
    console.log("Done, " + issues.length + " issues bounced!");
    return true;
  };

  IssuesBouncer.prototype.init = function () {
    var seconds = this.options.daysBeforeUnassign * 24 * 3600 * 1000;
    this.dateThreshold = new Date(new Date().getTime() - seconds);
    this.pullRequests = [];

    this.github = P.promisifyAll(new GitHubApi({
        version: "3.0.0",
        protocol: "https",
        timeout: this.options.requestsTimeout
    }));
    this.githubIssues = P.promisifyAll(this.github.issues);

    this.github.authenticate({
        type: "basic",
        username: this.options.githubUser,
        password: this.options.githubToken
    });
  };

  IssuesBouncer.prototype.run = function () {
    return this.onStart()
    .then(this.fetchAllIssues.bind(this))
    .then(this.concatNextPages.bind(this))
    .then(this.filterUnassignedIssues.bind(this))
    .then(this.fetchIssuesComments.bind(this))
    .then(this.separatePRs.bind(this))
    .then(this.fetchIssuesEvents.bind(this))
    .then(this.filterStaleIssues.bind(this))
    .then(this.takeActions.bind(this))
    .then(this.onFinish.bind(this));
  };

  return IssuesBouncer;
}();
