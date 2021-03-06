module.exports = Master;

var cluster = require('cluster');
var net = require('net');
var fs = require('fs');
var os = require('os');
var path = require('path');
var Log = require('log');

var ProcessMaster = require('./process_master');

var old_createServerHandle = net._createServerHandle;

var handles = [];

function close_server_handles() {
  handles.forEach(function(handle) {
    handle.close();
  }); 
}

net._createServerHandle = function() {
  var result = old_createServerHandle.apply(this, arguments);
  handles.push(result);
  return result;
}

function merge(defaults, props) {
  var result = {};
  Object.keys(defaults).forEach(function(key) {
    result[key] = defaults[key];
  });

  Object.keys(props).forEach(function(key) {
    result[key] = props[key];
  });

  return result;

}

function Master(module, opts) {
  this.module =  module;
  this.next_process_master_id = 1;

  opts = opts || {}

  var defaults = {
    workers: os.cpus().length,
    dir: path.dirname(process.argv[1]),
    heartbeat_timeout: 10 * 1000,
    startup_timeout: 60 * 1000,
    log_dir: "log",
    kill_wait_timeout: 30 * 1000,
    heartbeat_interval: 500
  };


  this.options = merge(defaults, opts);

  this.open_log();

  this.state = "starting";

  process.on("SIGQUIT", this.graceful_shutdown.bind(this));
  process.on("SIGHUP", this.graceful_restart.bind(this));
  process.on("SIGUSR2", this.reopen_logs.bind(this));

  this.old_master = null;
  this.current_master = null;

  this.log_lock = 0;
  this.new_master = this.start_master();
  
}


Master.prototype.relative_path = function(p) {
  return path.resolve(this.options.dir, p);
}

Master.prototype.open_log = function() {
  
  this.log = new Log('info', fs.createWriteStream(this.log_path(), {flags: "a"}));
  
}

Master.prototype.log_path = function() {
  return this.relative_path(path.join(this.options.log_dir, "master.log"));
}

Master.prototype.process_master_started = function(master) {

  this.log.info("[Master] New process master (%s) started", master.id);

  if (this.state == "new_master") {
    if (master == this.new_master) {
      
      this.state = "reap_master";
      this.old_master = this.current_master;
      this.current_master = this.new_master;
      this.new_master = null;
      this.log.info("[Master] Stopping old process master (%s)", this.old_master.id);
      this.old_master.stop();
    }
  } else if (this.state == "starting") {
    
    if (master == this.new_master) {
      this.log.info("[Master] Cluster initialized");
      this.state = "started";
      this.current_master = this.new_master;
      this.new_master = null;
    }
  }

}

Master.prototype.delete_master = function(master) {
  if (this.old_master == master) {
    this.old_master = null;
  } else if (this.new_master == master) {
    this.new_master = null;
  } else if (this.current_master == master) {
    this.current_master = null;
  }
}

Master.prototype.exit = function(code) {
  this.log.stream.once('close', function() {
    process.exit(code);
  });

  this.log.stream.destroySoon();
}

Master.prototype.process_master_stopped = function(master) {

  this.log.info("[Master] Process master (%s) stopped", master.id);

  if (this.state == "starting") {
    if (master == this.new_master) {
      this.log.info("[Master] Process master (%s) could not be started. Giving up.", master.id);
      this.exit(1);
    }
  } else if (this.state == "new_master") {
    if (master == this.new_master) {
      this.log.info("[Master] Process master (%s) could not be started. Cancelling restart", master.id);
      this.new_master = null;
      this.state = "started";
    }
  } else if (this.state == "reap_master") {
    if (master == this.old_master) {
      this.log.info("[Master] Old master has shutdown (%s). Restart complete", master.id);
      this.state = "started";
      this.old_master = null;
    }
  } else if (this.state == "stopping") {
    this.delete_master(master);
    if (this.old_master == null && this.new_master == null && this.current_master == null) {
      this.log.info("[Master] All masters have been stopped. Goodbye.");
      this.exit(0);
    }
  }
}

Master.prototype.graceful_restart = function() {
  if (this.state != "started") {
    this.log.info("[Master] Ignoring restart signal sent when not in started state. Current state is: %s", this.state);
    return;
  }

  this.state = "new_master";

  this.new_master = this.start_master();

}

Master.prototype.start_master = function() {
  var master = new ProcessMaster(this.next_process_master_id++, this.module, this.options, this.log);
  master.on("started", this.process_master_started.bind(this));
  master.on("stopped", this.process_master_stopped.bind(this));
  return master;
}

Master.prototype.graceful_shutdown = function() {
  if (this.state != "stopping" && this.state != "stopped") {
    this.log.info("[Master] Shutting down");
    close_server_handles();
    this.state = "stopping";
    this.each_master(function(master) {
      master.stop();
    });
  } else {
    this.log.info("[Master] Ignoring shutdown signal. Current state is: %s", this.state);
  }
}


Master.prototype.each_master = function(cb) {
  if (this.current_master != null) { 
    cb(this.current_master);
  }
  if (this.old_master != null) {
    cb(this.old_master);
  }
  if (this.new_master != null) {
    cb(this.new_master);
  }
}

Master.prototype.set_log = function(log) {
  this.log= log;
  this.each_master(function(master) {
    master.set_log(log);
  });
}

Master.prototype.reopen_master_log_file = function() {
  this.log.info("[Master] Opening New Master Log File");

  var stream = fs.createWriteStream(this.log_path(), {flags: "a"});
  var error_open_handler = function(e) {
      console.log(e, this.options.log_dir + "/master.log");
      this.log.error("[Master] Could not open new master log file");
      this.log_lock--;
  }.bind(this);
  stream.addListener("error", error_open_handler);
  stream.addListener("open", function() {
    /* swap logs */
    this.log.stream.destroySoon();
    this.set_log(new Log("info", stream));
    this.log.info("[Master] New Master Log File Opened");
    this.log_lock--;
    stream.removeListener("error", error_open_handler);
  }.bind(this));
  this.log_lock++;
}

Master.prototype.reopen_logs = function() {
  if (this.log_lock > 0) {
    this.log.info("[Master] Ignoring log reopen. Already reopening logs");
    return;
  }

  this.reopen_master_log_file();

}
