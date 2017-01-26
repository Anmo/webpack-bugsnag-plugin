const request = require('request-promise-native');
const pkgUp = require('pkg-up');
const url = require('url');
const {
  getCurrentBranch,
  getLatestCommitHash,
  getOriginRemoteUrl,
} = require('./git');

const USER_AGENT = (
  'WebpackBugsnagDeployPlugin/' +
  require('../../package.json').version
);
const BUGSNAG_DEPLOY_URL = 'https://notify.bugsnag.com/deploy';
const DEFAULT_OPTIONS = {
  apiKey: null,
  releaseStage: 'production',
  repository: null,
  provider: null,
  branch: null,
  revision: null, 
  appVersion: null,
};
const OPTIONS_WHITELIST = Object.keys(DEFAULT_OPTIONS);

/**
 * @constructor
 * @param {object} options
 */
function BugsnagDeployPlugin(options) {
  this.options = Object.assign(
    {},
    DEFAULT_OPTIONS,
    this.getSanitizedOptions(options)
  );

  if (!this.options.apiKey || this.options.apiKey.length !== 32) {
    throw new Error('You must provide a valid Bugsnag API key to the BugsnagDeployPlugin.');
  }
}

Object.assign(BugsnagDeployPlugin.prototype, {
  /**
   * Hooks into "after-emit", so once we know everything up to this point has gone smoothly,
   * we are pretty sure that everything has deployed successfully.
   * 
   * @see {deploy}
   */
  apply(compiler) {
    compiler.plugin('after-emit', (compilation, cb) => {
      this.deploy(compilation).then(cb).catch(err => {
        compilation.errors.push(err);
        cb();
      });
    });
  },

  /**
   * Returns an options object only containing properties which the deploy endpoint accepts.
   * The DEFAULT_OPTIONS object's keys are used as a whitelist.
   * 
   * @see {DEFAULT_OPTIONS}
   * @returns {object}
   */
  getSanitizedOptions(options) {
    const sanitized = {};
    if (options) {
      for (let key in options) {
        if (options.hasOwnProperty(key) && OPTIONS_WHITELIST.indexOf(key) !== -1) {
          sanitized[key] = options[key];
        }
      }
    }
    return sanitized;
  },

  /**
   * Checks to see whether or not some of the more useful options were omitted, and seeks
   * to find some sensible defaults (like reading the local git repository for the origin url,
   * current branch, commit, etc...)
   * 
   * The resolved object contains only the overrides - which are merged with the options before
   * sending the payload to the endpoint.
   * 
   * @param {?} compilation
   * @returns {Promise<object>}
   */
  getAutomaticDeployOptions(compilation) {
    return Promise.all([
      this.getAutomaticDeployOptionsFromPackageJSON(compilation),
      this.getAutomaticDeployOptionsFromGit(compilation),
    ]).then(([packageJSON, git]) => {
      return Object.assign({}, packageJSON, git);
    });
  },

  /**
   * Extracts some defaults from the closest package.json.
   * 
   * @param {?} compilation
   * @returns {Promise<object>}
   */
  getAutomaticDeployOptionsFromPackageJSON(compilation) {
    return (
      pkgUp()
        .then(path => {
          const package = require(path);
          return {
            appVersion: package.version || null,
            repository: package.repository ? package.repository.url : null,
          };
        })
        .catch(() => {}) // There may not be a package.json
    );
  },

  /**
   * Formats a remote URL so it does not contain any auth.
   * 
   * @param {string} remoteUrl
   * @returns {string}
   */
  formatRemoteUrl(remoteUrl) {
    const parsed = url.parse(remoteUrl);
    parsed.auth = null;
    const formatted = url.format(parsed);
    return formatted;
  },

  /**
   * Extracts some defaults from the closest package.json.
   * 
   * @param {?} compilation
   * @returns {Promise<object>}
   */
  getAutomaticDeployOptionsFromGit(compilation) {
    const path = compilation.compiler.options.context;
    return (
      Promise
        .all([
          getLatestCommitHash({ path }),
          getOriginRemoteUrl({ path }),
          getCurrentBranch({ path }),
        ])
        .then(([revision, repository, branch]) => {
          return {
            branch,
            revision,
            repository: this.formatRemoteUrl(repository),
          };
        })
        .catch(() => null)
    );
  },

  /**
   * Returns an object containing only the key/values which contained values.
   * 
   * @param {object} options
   * @returns {object}
   */
  stripEmptyOptions(options) {
    const stripped = {};
    for (let key in options) {
      if (options.hasOwnProperty(key) && options[key] != null) {
        stripped[key] = options[key];
      }
    }
    return stripped;
  },

  /**
   * Handles merging the automatic deploy options with the options specified in the constructor,
   * to form a set of paramaters to pass to the endpoint. Also strips out any empty options.
   * 
   * @see {getAutomaticDeployOptions}
   * @see {stripEmptyOptions}
   * @param {?} compilation
   * @returns {Promise<object>}
   */
  getRequestParams(compilation) {
    return (
      this.getAutomaticDeployOptions(compilation)
        .then(options => {
          return Object.assign(
            {},
            options, // Merge first as they're used as defaults
            this.stripEmptyOptions(this.options) // Only merge the set options
          );
        })
        .then(options => this.stripEmptyOptions(options))
    );
  },

  /**
   * Sends the deploy metadata payload to the endpoint.
   * 
   * @param {object} params
   * @returns {Promise<*>}
   */
  sendRequest(params) {
    return request({
      method: 'POST',
      uri: BUGSNAG_DEPLOY_URL,
      body: params,
      json: true,
      headers: {
        'user-agent': USER_AGENT,
      },
    });
  },

  /**
   * Handles gathering the request parameters, and passing them to the sendRequest method.
   * 
   * @see {getRequestParams}
   * @see {sendRequest}
   * @param {?} compilation
   * @returns {Promise<null>}
   */
  deploy(compilation) {
    return (
      this.getRequestParams(compilation)
        .then(options => this.sendRequest(options))
        .then(() => null)
    );
  },
});

module.exports = BugsnagDeployPlugin;
