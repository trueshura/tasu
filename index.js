const nats = require('nats');
const TRID = require('trid');
const EventEmitter = require('events');
const Logger = require('./lib/logger');
const RequestError = require('./lib/RequestError');

module.exports = class extends EventEmitter {

    /**
     *
     * @param options.group - used only for debug purposes
     */
    constructor(options) {
        super();

        const strLevel = process.env.LOG_LEVEL || 'error';
        const defaults = {
            url: 'nats://localhost:4222',
            requestTimeout: 10000,
            group: 'default',
            level: strLevel.toLowerCase()
        };
        this._options = {...defaults, ...options};
        const {group, level} = this._options;
        this._logger = this._options.logger || Logger({group, level});
        this._nats = nats.connect(options);
        this._trid = new TRID({prefix: group});
        this.id = this._trid.base();

        this.readyPromise = new Promise(resolve => {

            this._nats.on('connect', () => {
                this._state = 'connected';
                this._logger.info('connected to NATS server:', this._nats.currentServer.url.host);
                this._logger.info('id:', this.id);
                this._logger.info('group:', group);
                resolve();
            });
        });

        this._nats.on('error', (error) => {

            this._logger.error(`${error.message}${error.code ? ' (code: ' + error.code + ')' : ''}`);
            if (error.code === 'CONN_ERR') {
                this.emit('end', error.message);
            }
            this.emit('error', error);
        });

        this._nats.on('close', () => {
            this.emit('end', 'Connection was closed. No reconnect attempts will be made');
        });

        this._nats.on('disconnect', () => {

            if (this._state === 'connected') {
                this._logger.error('nats disconnected');
            }
            this._state = 'disconnected';
            this.emit('disconnected', 'Nats disconnected. Attempting to reconnect');
        });

        this._nats.on('reconnecting', () => {

            this._state = 'reconnecting';
            this._logger.info('nats reconnecting');
        });

        this._nats.on('reconnect', () => {

            this._state = 'connected';
            this._logger.info('nats reconnected');
            this.emit('reconnect');
        });
    }

    connected() {

        return this.readyPromise;
    }

    publish(subject, message) {

        this._logger.debug('publishing to', subject, message);
        this._nats.publish(subject, JSON.stringify(message), () => {
            this._logger.debug('message published', subject, message);
        });
    };

    // returned by `listen`, not to be used directly

    _respond(error, replyTo, response) {

        if (error) {
            this._logger.debug('sending error response to', replyTo, error);
            this._nats.publish(replyTo, JSON.stringify([{message: error.message || error.detail, stack: error.stack}]),
                () => {
                    this._logger.debug('error response sent to', replyTo);
                }
            );
        } else {
            this._nats.publish(replyTo, JSON.stringify([null, response]), () => {
            });
        }
    };

    /**
     * subscribe to point-to-point requests
     *
     * @see https://docs.nats.io/nats-concepts/queue vs
     *      https://docs.nats.io/nats-concepts/reqreply
     *
     * if you don't want to reply to response (we reply with return) just throw undefined
     *
     * @param {String} subject
     * @param {Function} done - async handler
     * @param {Boolean} bQueue - will use queue (default: only one receiver)
     * @return {Promise<unknown>}
     */
    listen(subject, done, bQueue = true) {

        const objOpts = {};
        let strLogRecord = 'subscribing to requests ' + subject;
        if (bQueue) {
            objOpts.queue = subject + '.listeners';
            strLogRecord += ' as member of ' + objOpts.queue;
        }
        this._logger.debug(strLogRecord);
        return this._nats.subscribe(subject, objOpts, async (message, reply) => {
            try {
                const result = await done(JSON.parse(message));
                this._respond(null, reply, result);
            } catch (error) {

                // we just don't want to reply
                if (error) this._respond(error, reply);
            }
        });
    };

    /**
     * subscribe to broadcasts
     *
     * @see https://docs.nats.io/nats-concepts/queue vs
     *      https://docs.nats.io/nats-concepts/reqreply
     *
     * if you don't want to reply to response (we reply with return) just throw undefined
     *
     * @param {String} subject
     * @param {Function} done - async handler
     * @param {Boolean} bQueue - will use queue (default: everyone receive)
     * @return {Promise<unknown>}
     */
    subscribe(subject, done, bQueue = false) {
        const objOpts = {};
        let strLogRecord = 'subscribing to broadcasts ' + subject;
        if (bQueue) {
            objOpts.queue = subject + '.listeners';
            strLogRecord += ' as member of ' + objOpts.queue;
        }
        this._logger.debug(strLogRecord, objOpts, subject);
        return this._nats.subscribe(subject, objOpts, (message, replyTo, subject) => {
            this._logger.debug('got broadcast', subject, message);
            done(JSON.parse(message), replyTo, subject);
        });
    };

    // process Absolete! see bQueue @listen

    /**
     *
     * @param subject
     * @param message
     * @return {Promise<unknown>}
     */
    request(subject, message = {}) {

        const meta = JSON.parse(JSON.stringify(message));  // important to clone here, as we are rewriting meta
        const id = this._trid.seq();
        this._logger.debug('[>>', id, '>>]', subject, meta);
        return new Promise((resolve, reject) => {
            this._nats.requestOne(subject, JSON.stringify(message), null, this._options.requestTimeout, (response) => {
                if (response.code && response.code === nats.REQ_TIMEOUT) {
                    this._logger.error('[!!', id, '!!] timeout', subject, message);
                    reject(new RequestError('response timeout', id));
                } else {
                    const resp = JSON.parse(response);
                    if (!Array.isArray(resp)) {
                        return reject(
                            new RequestError('Bad response! Expected "[error, response]"', id));
                    }

                    const [error, res] = resp;
                    if (error) {
                        this._logger.error('[!!', id, '!!] ', error.message, error.stack);
                        reject(new RequestError(error.message, id));
                    } else {
                        const meta = JSON.parse(JSON.stringify(res));
                        this._logger.debug('[<<', id, '<<]', subject, meta);
                        resolve(res);
                    }

                }
            });
        });
    };

    // unsubscribe from subscription by id

    unsubscribe(sid) {

        this._logger.debug(`unsubscribing from ${sid}`);
        this._nats.unsubscribe(sid);
    };

    // subscribe, receive, unsubscribe

    subOnce(subject, done) {

        this._logger.debug(`subscribing once to ${subject}...`);
        const sid = this._nats.subscribe(subject, (message, replyTo, subject) => {
            this._logger.debug('got message', subject, message, '- unsubscribing from', sid);
            this._nats.unsubscribe(sid);
            done(JSON.parse(message), subject);
        });
        return sid;
    }

    // close underlying connection with NATS

    close() {
        this._logger.info('closing connection with NATS:', this._nats.currentServer.url.host);
        this._nats.close();
    }
};