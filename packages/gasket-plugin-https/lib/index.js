const { createTerminus, HealthCheckError } = require('@godaddy/terminus');
const debug = require('diagnostics')('gasket:https');
const create = require('create-servers');
const one = require('one-time/async');
const errs = require('errs');
const isLocal = /local/;

/**
 * Check if the supplied errors are a result of the port being in use.
 *
 * @param {Array} errors Errors received from create-servers
 * @returns {Boolean} Indication if the port was in use.
 * @private
 */
function portInUseError(errors) {
  if (Array.isArray(errors)) {
    errors = errors[0];
  }
  return (errors.http2 || errors.https || errors.http || {}).code === 'EADDRINUSE';
}

/**
 * Start lifecycle of a gasket application
 *
 * @param {Gasket} gasket Gasket instance
 * @public
 */
async function start(gasket) {
  const { hostname, http2, https, http, terminus, env } = gasket.config;
  const { logger } = gasket;

  // Retrieving server opts
  const configOpts = { hostname };

  if (http) configOpts.http = http;
  if (https) configOpts.https = https;
  if (http2) configOpts.http2 = http2;

  const serverOpts = await gasket.execWaterfall('createServers', configOpts);
  const { healthcheck, ...terminusDefaults } = await gasket.execWaterfall('terminus', {
    healthcheck: ['/healthcheck', '/healthcheck.html'],
    signals: ['SIGTERM'],
    ...(terminus || {})
  });

  const routes = Array.isArray(healthcheck) ? healthcheck : [healthcheck];

  // Default port to non-essential port on creation
  // create-servers does not support http or https being `null`
  if (!serverOpts.http && !serverOpts.https && !serverOpts.http2) {
    serverOpts.http = isLocal.test(env) ? 8080 : 80;
  }

  async function healthCheckRequested() {
    await gasket.exec('healthcheck', HealthCheckError);
  }

  //
  // It's possible that we are creating multiple servers that are going to hook
  // into terminus. We want to eliminate the possibility of double lifecycle
  // execution so we're going to create a single options object that is going
  // to be used for all terminus based instances.
  //
  // Lifecycles that could potentially be called multiple times are wrapped
  // with a `one-time` function to ensure that the callback is only executed
  // once.
  //
  const terminusOpts = {
    logger: logger.error.bind(logger),
    onSendFailureDuringShutdown: one(async function onSendFailureDuringShutdown() {
      await gasket.exec('onSendFailureDuringShutdown');
    }),
    beforeShutdown: one(async function beforeShutdown() {
      await gasket.exec('beforeShutdown');
    }),
    onSignal: one(async function onSignal() {
      await gasket.exec('onSignal');
    }),
    onShutdown: one(async function onShutdown() {
      await gasket.exec('onShutdown');
    }),
    healthChecks: routes.reduce((acc, cur) => {
      acc[cur] = healthCheckRequested;
      return acc;
    }, {}),
    ...terminusDefaults
  };

  create(serverOpts, async function created(errors, servers) {
    if (errors) {
      let errorMessage;

      if (portInUseError(errors)) {
        errorMessage = errs.create({
          message: 'Port is already in use. Please ensure you are not running the same process from another terminal!',
          serverOpts
        });
      } else {
        errorMessage = errs.create({
          message: 'failed to start the http/https servers',
          serverOpts
        });
      }

      debug(errorMessage, errors);
      logger.error(errorMessage.message);
      return;
    }

    //
    // Attach terminus before we call the `servers` lifecycle to ensure that
    // everything is setup before the lifecycle is executed.
    //
    Object.values(servers)
      .reduce((acc, cur) => acc.concat(cur), [])
      .forEach((server) => createTerminus(server, terminusOpts));

    await gasket.exec('servers', servers);
    const { http: _http, https: _https, http2: _http2, hostname: _hostname = 'localhost' } = serverOpts;

    if (_http) {
      const _port = _http.port || _http;
      logger.info(`Server started at http://${_hostname}:${_port}/`);
    }

    if (_https || _http2) {
      logger.info(`Server started at https://${_hostname}:${(_https || _http2).port}/`);
    }
  });
}

module.exports = {
  name: require('../package').name,
  hooks: {
    start,
    metadata(gasket, meta) {
      return {
        ...meta,
        lifecycles: [{
          name: 'createServers',
          method: 'execWaterfall',
          description: 'Setup the `create-servers` options',
          link: 'README.md#createServers',
          parent: 'start'
        }, {
          name: 'terminus',
          method: 'execWaterfall',
          description: 'Setup the `terminus` options',
          link: 'README.md#terminus',
          parent: 'start',
          after: 'createServers'
        }, {
          name: 'servers',
          method: 'exec',
          description: 'Access to the server instances',
          link: 'README.md#servers',
          parent: 'start',
          after: 'terminus'
        }]
      };
    }
  }
};
