'use strict'

const LAST_POLL = 'externalsecret.kubernetes-client.io/last-poll'

/**
 * Kubernetes secret descriptor.
 * @typedef {Object} SecretDescriptor
 * @param {string} backendType - Backend to use for fetching secret data.
 * @param {string} name - Kubernetes secret name.
 * @param {Object[]} properties - Kubernetes secret properties.
 * @param {string} properties[].key - Secret key in the backend.
 * @param {string} properties[].name - Kubernetes Secret property name.
 * @param {string} properties[].property - If the backend secret is an
 *   object, this is the property name of the value to use.
 */

/** Poller class. */
class Poller {
  /**
   * Create poller.
   * @param {Object} backends - Backends for fetching secret properties.
   * @param {number} intervalMilliseconds - Interval time in milliseconds for polling secret properties.
   * @param {Object} kubeClient - Client for interacting with kubernetes cluster.
   * @param {Object} logger - Logger for logging stuff.
   * @param {string} namespace - Kubernetes namespace.
   * @param {SecretDescriptor} secretDescriptor - Kubernetes secret descriptor.
   */
  constructor ({
    backends,
    intervalMilliseconds,
    kubeClient,
    logger,
    namespace,
    secretDescriptor,
    ownerReference
  }) {
    this._backends = backends
    this._intervalMilliseconds = intervalMilliseconds
    this._kubeClient = kubeClient
    this._logger = logger
    this._namespace = namespace
    this._secretDescriptor = secretDescriptor
    this._ownerReference = ownerReference
    this._interval = null
  }

  /**
   * Create Kubernetes secret manifest.
   * @returns {Object} Promise object representing Kubernetes manifest.
   */
  async _createSecretManifest () {
    const secretDescriptor = this._secretDescriptor
    const data = await this._backends[secretDescriptor.backendType]
      .getSecretManifestData({ secretDescriptor })

    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretDescriptor.name,
        ownerReferences: [
          this._ownerReference
        ],
        annotations: {
          [LAST_POLL]: `${Date.now()}`
        }
      },
      type: 'Opaque',
      data
    }
  }

  /**
   * Poll Kubernetes secrets.
   * @returns {Promise} Promise object that always resolve.
   */
  async _poll () {
    this._logger.info('running poll')

    try {
      await this._upsertKubernetesSecret()
    } catch (err) {
      this._logger.error('failure while polling the secrets')
      this._logger.error(err)
    }

    this._setNextPoll()
  }

  /**
   * Create or update Kubernets secret in the cluster.
   * @returns {Promise} Promise object representing operation result.
   */
  async _upsertKubernetesSecret () {
    const secretDescriptor = this._secretDescriptor
    const secretName = secretDescriptor.name
    const secretManifest = await this._createSecretManifest()
    const kubeNamespace = this._kubeClient.api.v1.namespaces(this._namespace)

    this._logger.info(`upserting secret ${secretName} in ${this._namespace}`)
    try {
      return await kubeNamespace.secrets.post({ body: secretManifest })
    } catch (err) {
      if (err.statusCode !== 409) throw err
      return kubeNamespace.secrets(secretName).put({ body: secretManifest })
    }
  }

  /**
   * Checks if secret exists, if not trigger a poll
   * If secret already exists check when it was last polled and set timeout for next poll
   */
  async _checkForSecret () {
    const secretDescriptor = this._secretDescriptor
    const secretName = secretDescriptor.name
    const kubeNamespace = this._kubeClient.api.v1.namespaces(this._namespace)

    try {
      const {
        body: { metadata: { annotations = {} } = {} } = {}
      } = await kubeNamespace.secrets(secretName).get()

      const lastPoll = parseInt(annotations[LAST_POLL] || '0', 10)
      const nextPollIn = Math.max(lastPoll - (Date.now() - this._intervalMilliseconds), 0)

      this._setNextPoll(nextPollIn)
    } catch (err) {
      if (err.statusCode === 404) {
        this._logger.info('Secret does not exist, polling right away')
        this._poll()
      }
    }
  }

  _setNextPoll (nextPollIn = this._intervalMilliseconds) {
    if (this._interval) {
      clearTimeout(this._interval)
      this._interval = null
    }

    this._interval = setTimeout(this._poll.bind(this), nextPollIn)
    this._logger.debug('Next poll for %s in %s in %s', this._secretDescriptor.name, this._namespace, nextPollIn)
  }

  /**
   * Start poller.
   * @param {boolean} forcePoll - Trigger poll right away
   * @returns {Object} Poller instance.
   */
  start ({ forcePoll = false } = {}) {
    if (this._interval) return this

    this._logger.debug('starting poller')

    if (forcePoll) {
      this._poll()
    } else {
      this._checkForSecret()
    }

    return this
  }

  /**
   * Stop poller.
   * @returns {Object} Poller instance.
   */
  stop () {
    if (!this._interval) return this
    this._logger.debug('stopping poller')
    clearTimeout(this._interval)
    this._interval = null
    return this
  }
}

module.exports = Poller
