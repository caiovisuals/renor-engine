// Preload (`node --require`) that records every attempt the process makes to open a TCP connection or look up a host
// name, one line each, in the file RECORD_NETWORK_LOG names. It blocks nothing: a test reads the file afterwards.
// A connection to a local socket or a pipe is not the network and is not recorded.
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');

const log = process.env.RECORD_NETWORK_LOG;
if (!log) throw new Error('RECORD_NETWORK_LOG is not set');
const note = (line) => fs.appendFileSync(log, `${line}\n`);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net passes either the caller's arguments or one already-normalized array whose first item is the options.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] };
  if (options.path === undefined) note(`connect ${options.host ?? 'localhost'}:${options.port}`);
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  note(`lookup ${hostname}`);
  return lookup.call(this, hostname, ...rest);
};
