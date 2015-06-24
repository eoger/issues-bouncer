var IssuesBouncer = require("./lib/issues-bouncer");
var config = require("./config");
var argv = require("yargs").argv;

var options = config;
options.dryRun = argv.dryrun;
options.commentOnly = argv.noedit;

var bouncer = new IssuesBouncer(options);
bouncer.run();
