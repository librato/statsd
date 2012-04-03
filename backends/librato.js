/*
 * Flushes stats to Librato Metrics (https://metrics.librato.com).
 *
 * To enable this backend, include 'librato' in the backends
 * configuration array:
 *
 *   backends: ['librato']
 *
 * Accepts the following configuration hash:
 *
 *  "librato" : {
 *    "email" : Email address of your Librato Metrics account (req'd)
 *    "token" : API Token of your Librato Metrics accounts    (req'd)
 *    "sourceName" : Name of a source to use for metrics (optional)
 *    "legacyCounters": Boolean on whether or not all counters should be
 *                      reported as gauges, as was originally done with
 *                      Librato's statsd. Defaults to false which means
 *                      counters will be published as native Metrics counters.
 *  }
 */

var   net = require('net'),
     util = require('util'),
url_parse = require('url').parse,
    https = require('https'),
    http  = require('http');

var debug;
var api, email, token, period, sourceName;

// How long to wait before retrying a failed post, in seconds
var retryDelay = 5;
var libratoStats = {};
var basicAuthHeader;
var flushInterval;

// Previous versions treated counters as gauges, support
// a legacy mode to let users transition.
var legacyCounters = false;

// Statsd counters reset, we want monotonically increasing
// counters.
var libratoCounters = {};

var post_payload = function(options, proto, payload, retry)
{
  var req = proto.request(options, function(res) {
    // Retry 5xx codes
    if (Math.floor(res.statusCode / 100) == 5){
      res.on('data', function(d){
        var errdata = "HTTP " + res.statusCode + ": " + d;
        if (retry){
          if (debug) {
            util.log("Error sending metrics to Librato: " + errdata);
          }
          setTimeout(function() {
            post_payload(options, proto, payload, false);
          }, retryDelay * 1000);
        } else {
          util.log("Error connecting to Librato!\n" + errdata,"crit");
        }
      });
    }
    if (Math.floor(res.statusCode / 100) == 4){
      res.on('data', function(d){
        var errdata = "HTTP " + res.statusCode + ": " + d;
        if (debug) {
          util.log("Error sending metrics to Librato: " + errdata);
        }
      });
    }
  });

  req.write(payload);
  req.end();

  libratoStats['last_flush'] = Math.round(new Date().getTime() / 1000);
  req.on('error', function(errdata) {
    if (retry){
      setTimeout(function() {
        post_payload(options, proto, payload, false);
      }, retryDelay * 1000);
    } else {
      logger("Error connecting to Librato!\n" + errdata,"crit");
    }
  });
};

var post_metrics = function(ts, gauges, counters)
{
  var payload = {gauges: gauges,
                 counters: counters,
                 measure_time: ts};

  var parsed_host = url_parse(api || 'https://metrics-api.librato.com');

  // XXX: How does one lookup node.js version?
  var userAgent = "librato-statsd/0.1.0";

  if (sourceName) {
    payload.source = sourceName;
  }

  payload = JSON.stringify(payload);

  var options = {
    host: parsed_host["hostname"],
    port: parsed_host["port"] || 443,
    path: '/v1/metrics',
    method: 'POST',
    headers: {
      "Authorization": basicAuthHeader,
      "Content-Length": payload.length,
      "Content-Type": "application/json",
      "User-Agent" : userAgent
    }
  };

  var proto = http;
  if ((parsed_host["protocol"] || 'http:').match(/https/)) {
    proto = https;
  }

  post_payload(options, proto, payload, false);
};

var sanitize_name = function(name)
{
  return name.replace(/[^-.:_\w]+/, '_').substr(0,255)
};

var flush_stats = function(ts, metrics)
{
  var numStats = 0;
  var key;
  var counters = [];
  var gauges = [];

  for (key in metrics.counters) {
    if (legacyCounters) {
      gauges.push({name: sanitize_name(key),
                   value: metrics.counters[key]});
      continue;
    }

    if (!libratoCounters[key]) {
      libratoCounters[key] = {value: metrics.counters[key],
                              lastUpdate: ts};
    } else {
      libratoCounters[key].value += metrics.counters[key];
      libratoCounters[key].lastUpdate = ts;
    }

    counters.push({name: sanitize_name(key),
                   value: libratoCounters[key].value});
  }

  for (key in metrics.timers) {
    var count = metrics.timers[key].length;
    var min = null;
    var max = null;
    var sum = 0;
    var sumOfSquares = 0;

    if (count == 0) {
      continue;
    }

    for (var i = 0; i < metrics.timers[key].length; i++) {
      var val = metrics.timers[key][i];

      if (min == null || val < min) { min = val; }
      if (max == null || val > max) { max = val; }

      sum += val;
      sumOfSquares += val * val;
    }

    var gauge = {
      name: sanitize_name(key),
      count: count,
      sum: sum,
      sum_squares: sumOfSquares,
      min: min,
      max: max
    };

    gauges.push(gauge);
  }

  for (key in metrics.gauges) {
    gauges.push({name: sanitize_name(key),
                 value: metrics.gauges[key]});
  }

  numStats = gauges.length + counters.length;

  if (legacyCounters) {
    gauges.push({name: 'numStats',
                 value: numStats});
  } else {
    if (libratoCounters['numStats']) {
      libratoCounters['numStats'].value += numStats;
      libratoCounters['numStats'].lastUpdate = ts;
    } else {
      libratoCounters['numStats'] = {value: numStats,
                                     lastUpdate: ts};
    }

    counters.push({name: 'numStats',
                   value: libratoCounters['numStats'].value});
  }

  post_metrics(ts, gauges, counters);

  // Delete any counters that were not published, as they
  // were deleted.
  var toDelete = [];
  for (key in libratoCounters) {
    if (libratoCounters[key].lastUpdate == ts) {
      continue;
    }

    toDelete.push(key);
  }

  for (var i = 0; i < toDelete.length; i++) {
    delete libratoCounters[toDelete[i]];
  }
};

var backend_stats = function(writeCb) {
  for (stat in libratoStats) {
    writeCb(stat, libratoStats[stat]);
  }
};

var build_basic_auth = function(email, token)
{
  return 'Basic ' + new Buffer(email + ':' + token).toString('base64');
}

var init_librato = function(startup_time, config)
{
  debug = config.debug;

  // Prefer config options nested under the top-level 'librato' hash
  if (config.librato) {
    api = config.librato.api;
    email = config.librato.email;
    token = config.librato.token;
    sourceName = config.librato.source;
    legacyCounters = config.librato.legacyCounters;
  } else {
    // Fall back to deprecated top-level config variables
    api = config.libratoHost;
    email = config.libratoUser;
    token = config.libratoApiKey;
    sourceName = config.libratoSource;
  }

  if (!email || !token) {
    util.log("Error: Invalid configuration for Librato Metrics backend");
    return false;
  }

  flushInterval = config.flushInterval;
  basicAuthHeader = build_basic_auth(email, token);

  return true;
};


exports.init = init_librato;
exports.flush = flush_stats;
exports.stats = backend_stats;
