/* eslint-env mocha */
'use strict'

const { expect } = require('chai')
const sinon = require('sinon')

const Poller = require('./poller')

describe('Poller', () => {
  let backendMock
  let kubeClientMock
  let loggerMock
  let metricsMock
  let pollerFactory

  const ownerReference = {
    apiVersion: 'owner-api/v1',
    controller: true,
    kind: 'MyKind',
    name: 'fakeSecretName',
    uid: '4c10d879-2646-40dc-8595-d0b06b60a9ed'
  }

  beforeEach(() => {
    backendMock = sinon.mock()
    kubeClientMock = sinon.mock()
    loggerMock = sinon.mock()
    metricsMock = sinon.mock()

    loggerMock.info = sinon.stub()
    loggerMock.debug = sinon.stub()
    loggerMock.error = sinon.stub()

    metricsMock.observeSync = sinon.stub()

    pollerFactory = (secretDescriptor = {
      backendType: 'fakeBackendType',
      name: 'fakeSecretName',
      properties: [
        'fakePropertyName1',
        'fakePropertyName2'
      ]
    }) => new Poller({
      secretDescriptor,
      backends: {
        fakeBackendType: backendMock
      },
      metrics: metricsMock,
      intervalMilliseconds: 5000,
      kubeClient: kubeClientMock,
      logger: loggerMock,
      namespace: 'fakeNamespace',
      ownerReference
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('_createSecretManifest', () => {
    let clock

    beforeEach(() => {
      clock = sinon.useFakeTimers({
        now: Date.now()
      })
      backendMock.getSecretManifestData = sinon.stub()
    })

    afterEach(() => {
      clock.restore()
    })

    it('creates secret manifest - no type (backwards compat)', async () => {
      const poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        properties: [
          'fakePropertyName1',
          'fakePropertyName2'
        ]
      })

      backendMock.getSecretManifestData.resolves({
        fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
        fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
      })

      const secretManifest = await poller._createSecretManifest()

      expect(backendMock.getSecretManifestData.calledWith({
        secretDescriptor: {
          backendType: 'fakeBackendType',
          name: 'fakeSecretName',
          properties: [
            'fakePropertyName1',
            'fakePropertyName2'
          ]
        }
      })).to.equal(true)

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName',
          ownerReferences: [ownerReference],
          annotations: {
            'externalsecret.kubernetes-client.io/last-poll': `${Date.now()}`
          }
        },
        type: 'Opaque',
        data: {
          fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
          fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
        }
      })
    })

    it('creates secret manifest - with type', async () => {
      const poller = pollerFactory({
        type: 'dummy-test-type',
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        properties: [
          'fakePropertyName1',
          'fakePropertyName2'
        ]
      })

      backendMock.getSecretManifestData.resolves({
        fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
        fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
      })

      const secretManifest = await poller._createSecretManifest()

      expect(backendMock.getSecretManifestData.calledWith({
        secretDescriptor: {
          type: 'dummy-test-type',
          backendType: 'fakeBackendType',
          name: 'fakeSecretName',
          properties: [
            'fakePropertyName1',
            'fakePropertyName2'
          ]
        }
      })).to.equal(true)

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName',
          ownerReferences: [ownerReference],
          annotations: {
            'externalsecret.kubernetes-client.io/last-poll': `${Date.now()}`
          }
        },
        type: 'dummy-test-type',
        data: {
          fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
          fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
        }
      })
    })
  })

  describe('_poll', () => {
    let poller
    beforeEach(() => {
      poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName1',
        properties: ['fakePropertyName1', 'fakePropertyName2']
      })
      poller._upsertKubernetesSecret = sinon.stub()
      poller._setNextPoll = sinon.stub()
    })

    it('polls secrets', async () => {
      poller._upsertKubernetesSecret.resolves()

      await poller._poll()
      expect(loggerMock.info.calledWith(`running poll on the secret ${poller._secretDescriptor.name}`)).to.equal(true)

      expect(metricsMock.observeSync.getCall(0).args[0]).to.deep.equal({
        name: 'fakeSecretName1',
        namespace: 'fakeNamespace',
        backend: 'fakeBackendType',
        status: 'success' })
      expect(poller._upsertKubernetesSecret.calledWith()).to.equal(true)
      expect(poller._setNextPoll.calledWith()).to.equal(true)
    })

    it('logs error if storing secret operation fails', async () => {
      const error = new Error('fake error message')
      poller._upsertKubernetesSecret.throws(error)

      await poller._poll()

      expect(metricsMock.observeSync.getCall(0).args[0]).to.deep.equal({
        name: 'fakeSecretName1',
        namespace: 'fakeNamespace',
        backend: 'fakeBackendType',
        status: 'error' })
      expect(loggerMock.error.calledWith(error, `failure while polling the secret ${poller._secretDescriptor.name}`)).to.equal(true)
    })
  })

  describe('_checkForSecret', () => {
    let kubeNamespaceMock
    let poller
    let clock

    beforeEach(() => {
      poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        properties: ['fakePropertyName']
      })
      clock = sinon.useFakeTimers({
        now: Date.now()
      })
      kubeNamespaceMock = sinon.mock()
      kubeNamespaceMock.secrets = sinon.stub().returns(kubeNamespaceMock)
      kubeClientMock.api = sinon.mock()
      kubeClientMock.api.v1 = sinon.mock()
      kubeClientMock.api.v1.namespaces = sinon.stub().returns(kubeNamespaceMock)
      poller._setNextPoll = sinon.stub()
      poller._poll = sinon.stub()
    })

    afterEach(() => {
      clock.restore()
    })

    it('existing secret - no last poll', async () => {
      kubeNamespaceMock.get = sinon.stub().resolves({
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'fakeSecretName'
          },
          type: 'Opaque',
          data: {
            fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
          }
        }
      })

      await poller._checkForSecret()

      expect(kubeNamespaceMock.secrets.calledWith('fakeSecretName')).to.equal(true)
      expect(poller._setNextPoll.calledWith(0)).to.equal(true)
    })

    describe('with last poll', () => {
      beforeEach(() => {
        kubeNamespaceMock.get = sinon.stub().resolves({
          body: {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: 'fakeSecretName',
              annotations: {
                'externalsecret.kubernetes-client.io/last-poll': `${Date.now()}`
              }
            },
            type: 'Opaque',
            data: {
              fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
            }
          }
        })
      })

      it('time remaining until next poll', async () => {
        const elapsedTime = 2000
        clock.tick(elapsedTime)

        await poller._checkForSecret()

        expect(kubeNamespaceMock.secrets.calledWith('fakeSecretName')).to.equal(true)
        expect(poller._setNextPoll.calledWith(poller._intervalMilliseconds - elapsedTime)).to.equal(true)
      })

      it('ready for next poll', async () => {
        clock.tick(poller._intervalMilliseconds * 2) // greater than poller._intervalMilliseconds

        await poller._checkForSecret()

        expect(kubeNamespaceMock.secrets.calledWith('fakeSecretName')).to.equal(true)
        expect(poller._setNextPoll.calledWith(0)).to.equal(true)
      })
    })

    it('not existing secret', async () => {
      kubeNamespaceMock.get = sinon.stub().throws({ statusCode: 404 })

      await poller._checkForSecret()

      expect(poller._poll.calledWith()).to.equal(true)
    })

    it('logs error if it fails', async () => {
      const error = new Error('something boom')
      kubeNamespaceMock.get = sinon.stub().throws(error)

      await poller._checkForSecret()

      expect(loggerMock.error.calledWith(error, 'Secret check went boom for %s in %s', 'fakeSecretName', 'fakeNamespace')).to.equal(true)
    })
  })

  describe('_upsertKubernetesSecret', () => {
    let kubeNamespaceMock
    let poller
    let fakeNamespace

    beforeEach(() => {
      poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        properties: ['fakePropertyName']
      })
      fakeNamespace = {
        body: {
          metadata: {
            annotations: {}
          }
        }
      }
      kubeNamespaceMock = sinon.mock()
      kubeNamespaceMock.secrets = sinon.stub().returns(kubeNamespaceMock)
      kubeNamespaceMock.get = sinon.stub().resolves(fakeNamespace)
      kubeClientMock.api = sinon.mock()
      kubeClientMock.api.v1 = sinon.mock()
      kubeClientMock.api.v1.namespaces = sinon.stub().returns(kubeNamespaceMock)
      poller._createSecretManifest = sinon.stub().returns({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName'
        },
        type: 'some-type',
        data: {
          fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
        }
      })
    })

    it('creates new secret', async () => {
      kubeNamespaceMock.secrets.post = sinon.stub().resolves()

      await poller._upsertKubernetesSecret()

      expect(kubeNamespaceMock.secrets.post.calledWith({
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'fakeSecretName'
          },
          type: 'some-type',
          data: {
            fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
          }
        }
      })).to.equal(true)
    })

    it('updates secret', async () => {
      const conflictError = new Error('Conflict')
      conflictError.statusCode = 409
      kubeNamespaceMock.secrets.post = sinon.stub().throws(conflictError)
      kubeNamespaceMock.put = sinon.stub().resolves()
      kubeNamespaceMock.get = sinon.stub().resolves(fakeNamespace)

      await poller._upsertKubernetesSecret()

      expect(kubeNamespaceMock.secrets.calledWith('fakeSecretName')).to.equal(true)

      expect(kubeNamespaceMock.put.calledWith({
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'fakeSecretName'
          },
          type: 'some-type',
          data: {
            fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
          }
        }
      })).to.equal(true)
    })

    it('does not permit update of secret', async () => {
      fakeNamespace.body.metadata.annotations['iam.amazonaws.com/permitted'] = '^$'
      poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        roleArn: 'arn:aws:iam::123456789012:role/test-role',
        properties: ['fakePropertyName']
      })
      kubeNamespaceMock.get = sinon.stub().resolves(fakeNamespace)

      let error
      try {
        await poller._upsertKubernetesSecret()
      } catch (err) {
        error = err
      }

      expect(error).to.not.equal(undefined)
      expect(error.message).equals('not allowed to fetch secret: fakeSecretName: namspace does not allow to assume role arn:aws:iam::123456789012:role/test-role')
    })

    it('fails storing secret', async () => {
      const internalErrorServer = new Error('Internal Error Server')
      internalErrorServer.statusCode = 500

      kubeNamespaceMock.secrets.post = sinon.stub().throws(internalErrorServer)

      let error

      try {
        await poller._upsertKubernetesSecret()
      } catch (err) {
        error = err
      }

      expect(error).to.not.equal(undefined)
      expect(error.message).equals('Internal Error Server')
    })
  })

  describe('start', () => {
    let poller

    beforeEach(() => {
      poller = pollerFactory()
      poller._poll = sinon.stub()
      poller._checkForSecret = sinon.stub()
    })

    afterEach(() => {
      poller.stop()
    })

    it('starts poller on force poll', async () => {
      expect(poller._timeoutId).to.equal(null)

      poller.start({ forcePoll: true })

      expect(loggerMock.debug.calledWith('starting poller')).to.equal(true)
      expect(poller._poll.called).to.equal(true)
    })

    it('checks for secret if not forced poll', async () => {
      expect(poller._timeoutId).to.equal(null)

      poller.start({ forcePoll: false })

      expect(loggerMock.debug.calledWith('starting poller')).to.equal(true)
      expect(poller._poll.called).to.equal(false)
      expect(poller._checkForSecret.called).to.equal(true)
    })
  })

  describe('stop', () => {
    let poller

    beforeEach(() => {
      poller = pollerFactory()
      poller._poll = sinon.stub()
    })

    it('stops poller', async () => {
      poller._timeoutId = 'some id'

      expect(poller._timeoutId).to.not.equal(null)

      poller.stop()

      expect(loggerMock.debug.calledWith('stopping poller')).to.equal(true)
      expect(poller._timeoutId).to.equal(null)
    })
  })
  describe('assume-role permissions', () => {
    let poller
    beforeEach(() => {
      poller = pollerFactory()
    })

    it('should restrict access to certain roles per namespace ', () => {
      const testcases = [
        {
          // no annotations at all
          ns: { metadata: {} },
          descriptor: {},
          permitted: true
        },
        {
          // empty annotation
          ns: { metadata: { annotations: { 'iam.amazonaws.com/permitted': '' } } },
          descriptor: {},
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { 'iam.amazonaws.com/permitted': '.*' } } },
          descriptor: { roleArn: 'whatever' },
          permitted: true
        },
        {
          // test regex: deny access
          ns: { metadata: { annotations: { 'iam.amazonaws.com/permitted': '^$' } } },
          descriptor: { roleArn: 'whatever' },
          permitted: false
        },
        {
          // real world example
          ns: { metadata: { annotations: { 'iam.amazonaws.com/permitted': 'arn:aws:iam::123456789012:role/.*' } } },
          descriptor: { roleArn: 'arn:aws:iam::123456789012:role/somerole' },
          permitted: true
        }
      ]

      for (let i = 0; i < testcases.length; i++) {
        const testcase = testcases[i]
        const verdict = poller._isPermitted(testcase.ns, testcase.descriptor)
        expect(verdict.allowed).to.equal(testcase.permitted)
      }
    })
  })
})
