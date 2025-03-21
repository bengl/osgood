{
  const debug = self._debug || (() => {});
  delete self._debug;
  const startResponse = self._startResponse;
  delete self._startResponse;
  const writeResponse = self._writeResponse;
  delete self._writeResponse;
  const setTimeout = self._setTimeout;
  delete self._setTimeout;
  const setInterval = self._setInterval;
  delete self._setInterval;
  const clearTimer = self._clearTimer;
  delete self._clearTimer;
  const _log = self._log;
  delete self._log;
  const _error = self._error;
  delete self._error;
  const _fetch = self._fetch;
  delete self._fetch;
  const _route = self._route;
  delete self._route;

  // console methods

  function inspect(obj) {
    const INDENT = 2;
    const seen = new WeakSet();
    let depth = 0;

    function pad(groupTerm) {
      return ' '.repeat(groupTerm ? depth - INDENT : depth);
    }

    function dive(node) {
      depth += INDENT;
      if (node === null) {
        depth -= INDENT;
        return `null`;
      }
      if (Array.isArray(node)) {
        let result = `[\n`;
        for (let item of node) {
          result += `${pad()}${dive(item)}\n`;
        }
        result += `${pad(true)}]`;
        depth -= INDENT;
        return result;
      }
      if (node instanceof URLSearchParams) {
        depth -= INDENT;
        return `URLSearchParams { ${node.toString()} }`;
      }
      if (node instanceof self.FormData) {
        depth -= INDENT;
        const pairs = [];
        for (const fd of node) {
          // Using stringify to escape quotes and remove ambiguity for human reader
          pairs.push(`${fd[0]}=${JSON.stringify(fd[1])}`);
        }
        return `FormData { ${pairs.join(', ')} }`;
      }

      const type = typeof node;

      switch (type) {
        case 'undefined':
          depth -= INDENT;
          return `undefined`;
        case 'function':
          depth -= INDENT;
          return `${node.name}(${node.length})`;
        case 'bigint':
          depth -= INDENT;
          return `${node}n`;
        case 'number':
        case 'boolean':
        case 'symbol':
          depth -= INDENT;
          return `${String(node)}`;
        case 'string':
          depth -= INDENT;
          return `'${node}'`;
        case 'object':
          if (seen.has(node)) {
            depth -= INDENT;
            return `[CIRCULAR]`;
          }
          seen.add(node);
          const keys = Reflect.ownKeys(node);
          let result = `${
            node.constructor !== Object && node.constructor !== undefined ? node.constructor.name + ' ' : ''
          }{\n`;
          for (let key of keys) {
            result += `${pad()}${String(key)}: ${dive(node[key])}\n`;
          }
          result += `${pad(true)}}`;
          depth -= INDENT;
          return result;
        default:
          throw new Error(`unknown type: ${type}`);
      }
    }

    return dive(obj);
  }

  const formatLog = args =>
    args.map(x => (typeof x === 'string' ? x : inspect(x))).join(' ');

  console.log = (...args) => {
    _log(formatLog(args));
  };

  console.error = (...args) => {
    _error(formatLog(args));
  };

  console.warn = (...args) => {
    _error(formatLog(args));
  };

  console.info = (...args) => {
    _log(formatLog(args));
  };

  console.debug = (...args) => {
    _log(formatLog(args));
  };

  console.trace = (...args) => {
    const { stack } = new Error();
    const formattedStack = stack
      .split('\n')
      .slice(2)
      .join('\n');
    _log(`${formatLog(args)}\n${formattedStack}`);
  };

  // request context

  const REGEX_CAPTURE_GROUPS = /\:([a-zA-Z0-9_]+)/g;
  const REPLACE_CAPTURE_GROUPS = '(?<$1>[^\\/]+)'; // named capture groups

  const REGEX_DOUBLE_ASTERISK = /\*\*/g;
  const REPLACE_DOUBLE_ASTERISK = '(.+)'; // unnamed capture group

  const REGEX_SINGLE_ASTERISK = /\*/g;
  const REPLACE_SINGLE_ASTERISK = '([^\\/]+)'; // unnamed capture group

  function patternToRegExp(pattern) {
    const matcherString = pattern
      .replace(REGEX_CAPTURE_GROUPS, REPLACE_CAPTURE_GROUPS)
      .replace(REGEX_DOUBLE_ASTERISK, REPLACE_DOUBLE_ASTERISK)
      .replace(REGEX_SINGLE_ASTERISK, REPLACE_SINGLE_ASTERISK)
      .replace(/\//g, '\\\/');
    return new RegExp(`^${matcherString}$`);
  }

  const routeRegex = patternToRegExp(_route);

  function parseParamsFromUrlPath(url) {
    const { pathname } = new URL(url);
    const {groups} = routeRegex.exec(pathname) || {};
    return groups;
  }


  const fetchCbs = {};

  const inFlightInbounds = {};

  let timerIdCounter = 0;
  const timerMap = new Map();

  const writerMap = new WeakMap();

  function handleFetch(err, body, meta, fetchId) {
    fetchCbs[fetchId](err, body, meta);
  }
  _setFetchHandler(handleFetch);
  delete self._setFetchHandler;

  function handleTimer(timerId) {
    timerMap.get(timerId)();
  }
  _setTimerHandler(handleTimer);
  delete self._setTimerHandler;

  function generateContextObject(url) {
    let params;
    let query;
    return {
      get query() {
        return params || (params = new URL(url).searchParams);
      },
      get params() {
        return query || (query = parseParamsFromUrlPath(url));
      }
    };
  }

  // This function checks to see if the object should serialize into a POJO
  // Object, one that is free of class instances. "Double getters" do exist.
  // For example, it could first reply wth a string, and later reply a class
  // instance. Keep in mind this check is done to prevent a foot gun, not for
  // security purposes. If it were for security we'd construct a shadow object
  // and copy properties. Double Getter's are explained here:
  // https://medium.com/intrinsic/protecting-your-javascript-apis-9ce5b8a0e3b5
  function shouldSerializeIntoPOJO(obj) {
    if (obj === null) {
      return true;
    } else if (typeof obj !== 'object') {
      return true;
    }

    if (obj.toJSON) {
      obj = obj.toJSON();
    }

    if (obj === null) {
      return true;
    } else if (typeof obj !== 'object') {
      return true;
    }

    const proto = Object.getPrototypeOf(obj);

    if (proto === Array.prototype) {
      for (let value of obj) {
        if (!shouldSerializeIntoPOJO(value)) {
          return false;
        }
      }
      return true;
    } else if (proto !== Object.prototype && proto !== null) {
      return false;
    } else {
      // intentionally ignore Symbol properties as they're ignored by JSON.stringify
      for (let value of Object.values(obj)) {
        if (!shouldSerializeIntoPOJO(value)) {
          return false;
        }
      }
      return true;
    }
  }

  async function handleIncomingReqHead(reqId, fn, method, url, headers) {
    const passthrough = new PassThrough();
    const body = passthrough.readable;
    const request = new Request(url, {
      method,
      headers,
      body
    });
    writerMap.set(request, passthrough.writable.getWriter());
    inFlightInbounds[reqId] = request;
    let response;
    try {
      if (typeof fn !== 'function') {
        throw new TypeError('Worker did not provide a valid handler');
      }
      response = await fn(request, generateContextObject(url));
      switch (typeof response) {
        case 'string': {
          const headers = new Headers({
            'Content-Type': 'text/plain'
          });

          response = new Response(response, { headers });
          break;
        }
        case 'object': {
          if (response === null) {
            throw new TypeError('Response was an invalid object');
          }
          if (response instanceof Response) {
            // we're good!
          } else if (isBufferish(response)) {
            response = new Response(response, {
              headers: new Headers({
                'Content-Type': 'application/octet-stream'
              })
            });
          } else {
            if (shouldSerializeIntoPOJO(response)) {
              const body = JSON.stringify(response);
              response = new Response(body, {
                headers: new Headers({
                  'Content-Type': 'application/json'
                })
              });
            } else {
              throw new TypeError('Response object must be a POJO');
            }
          }
          break;
        }
        default:
          throw new TypeError(`Invalid response type "${typeof response}"`);
      }
    } catch (e) {
      console.error(e.stack);
      response = new Response('', { status: 500 });
    }

    if (response.body) {
      startResponse(response, reqId);
      let stream =
        response.body instanceof TransformStream
          ? response.body.readable
          : response.body;
      for await (let chunk of stream) {
        writeResponse(chunkAsArrayBuffer(chunk), reqId);
      }
      writeResponse(null, reqId);
    } else {
      startResponse(response, reqId, response._bodyString);
    }

    delete inFlightInbounds[reqId];
  }
  _setIncomingReqHeadHandler(handleIncomingReqHead);
  delete self._setIncomingReqHeadHandler;

  async function handleIncomingReqBody(reqId, body) {
    let writer = writerMap.get(inFlightInbounds[reqId]);
    await writer.ready;
    if (typeof body === 'undefined') {
      await writer.close();
    } else {
      await writer.write(body);
    }
  }
  _setIncomingReqBodyHandler(handleIncomingReqBody);
  delete self._setIncomingReqBodyHandler;

  function parseUrl(url) {
    const urlObj = new URL(url);
    const newObj = {};
    for (const key of ['protocol', 'hostname', 'port', 'pathname']) {
      newObj[key] = urlObj[key];
    }
    newObj.port = newObj.port || '80';
    if (urlObj.search) {
      newObj.pathname = newObj.pathname + urlObj.search;
    }
    return newObj;
  }

  let increasingFetchId = 0;
  async function fetch(input, init) {
    const fetchId = ++increasingFetchId;
    const p = new Promise((resolve, reject) => {
      let result = '';
      let responseObj = null;
      let writer = null;
      fetchCbs[fetchId] = (err, data, meta) => {
        if (err) {
          err = new Error(err);
          reject(err);
          console.error('rejected fetch call due to: ' + err);
          return;
        }
        if (meta) {
          let passthrough = new PassThrough();
          responseObj = new Response(passthrough.readable, meta);
          writer = passthrough.writable.getWriter();
          resolve(responseObj);
        } else if (data === null) {
          writer.ready.then(() => writer.close());
          delete fetchCbs[fetchId];
        } else {
          if (data instanceof ArrayBuffer) {
            data = new Uint8Array(data);
          }
          writer.ready.then(() => writer.write(data));
        }
      };
    });

    if (typeof input === 'string') {
      input = new Request(input, init);
    }
    const parsedUrl = parseUrl(input.url);

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new TypeError(`Unsupported protocol: "${parsedUrl.protocol}"`);
    }

    if (typeof input._bodyString === 'string') {
      _fetch(
        parsedUrl,
        input.url,
        input.headers,
        input.method.toUpperCase(),
        input._bodyString,
        fetchId,
        'string'
      );
    } else if (input.body instanceof self.FormData) {
      const { contentType, body } = generateMultipartFormData(input.body);

      input.headers.set('Content-Type', contentType);

      _fetch(
        parsedUrl,
        input.url,
        input.headers,
        input.method.toUpperCase(),
        body,
        fetchId,
        'string'
      );
    } else if (typeof input.body === 'object') {
      _fetch(
        parsedUrl,
        input.url,
        input.headers,
        input.method.toUpperCase(),
        input._bodyString,
        fetchId,
        'stream'
      );
      for await (const chunk of input.body) {
        _fetch(null, null, null, null, chunk, fetchId, 'stream');
      }
      _fetch(null, null, null, null, false, fetchId, 'stream');
    } else {
      _fetch(
        parsedUrl,
        input.url,
        input.headers,
        input.method.toUpperCase(),
        null,
        fetchId,
        'none'
      );
    }

    return p;
  }
  self.fetch = fetch;

  function defineReadOnly(obj, prop, value) {
    Reflect.defineProperty(obj, prop, {
      value,
      enumerable: true,
      configurable: true,
      writable: false
    });
  }

  function chunkAsArrayBuffer(chunk) {
    if (!(chunk instanceof ArrayBuffer)) {
      if (typeof chunk === 'string') {
        const enc = new TextEncoder();
        chunk = enc.encode(chunk).buffer;
      }
      if (typeof chunk === 'object') {
        if (chunk.buffer && chunk.buffer instanceof ArrayBuffer) {
          chunk = chunk.buffer;
        } else {
          throw new TypeError(
            'body chunks must be strings, ArrayBuffers, TypedArrays or DataViews'
          );
        }
      }
    }
    return chunk;
  }

  function isBufferish(chunk) {
    if (!chunk) {
      return false;
    }
    return chunk instanceof ArrayBuffer ||
      (chunk.buffer && chunk.buffer instanceof ArrayBuffer);
  }

  function unimplemented() {
    throw new Error('Unimplemented!');
  }

  // FIXME: This currently only implements pair iterators!
  // https://heycam.github.io/webidl/#idl-iterable
  class IteratorMixin {
    // https://heycam.github.io/webidl/#es-iterable-entries
    entries() {
      return this[Symbol.iterator]();
    }

    // https://heycam.github.io/webidl/#es-forEach
    forEach() {
      unimplemented();
    }

    // https://heycam.github.io/webidl/#es-iterable-keys
    *keys() {
      for (const [key, value] of this) {
        yield key;
      }
    }

    // https://heycam.github.io/webidl/#es-iterable-values
    *values() {
      for (const [key, value] of this) {
        yield value;
      }
    }

    static mixin(klass) {
      if (!(Symbol.iterator in klass.prototype)) {
        throw new Error('Cannot mixin IteratorMixin because class is not iterable');
      }
      for (const key of Reflect.ownKeys(IteratorMixin.prototype)) {
        if (key === 'constructor') {
          continue;
        }
        if (key in klass.prototype) {
          throw new Error(`Cannot mixin IteratorMixin because key '${key}' already exists`);
        }
        klass.prototype[key] = IteratorMixin.prototype[key];
      }
    }
  }

  class Headers {
    constructor(init = {}) {
      // TODO This really should be private and not exposed to user code. It's
      // exposed for now to more easily pass it into native code. In the future,
      // we can just call `entries()` to get the underlying headers.
      this._headers = {};
      if (init instanceof Headers) {
        for (const [name, value] of Headers.prototype.keys.apply(init)) {
          this.append(name, value);
        }
      } else if (typeof init === 'object') {
        if (Symbol.iterator in init) {
          for (const header of init) {
            if (typeof header !== 'object' || !(Symbol.iterator in header)) {
              throw new TypeError('Invalid headers');
            }
            let [name, value, ...extras] = [...header];
            if (extras.length !== 0) {
              throw new TypeError('Invalid headers');
            }
            this.append(name, value);
          }
        } else {
          for (const [name, value] of Object.entries(init)) {
            this.append(name, value);
          }
        }
      } else {
        throw new TypeError('Invalid headers');
      }
    }

    set(name, value) {
      name = normalizeHeaderName(name);
      value = normalizeHeaderValue(value);
      this._headers[name] = String(value);
    }

    append(name, value) {
      name = normalizeHeaderName(name);
      value = normalizeHeaderValue(value);
      if (name in this._headers) {
        this._headers[name] += ', ' + value;
      } else {
        this._headers[name] = value;
      }
    }

    get(name) {
      name = normalizeHeaderName(name);
      return this._headers[name];
    }

    has(name) {
      name = normalizeHeaderName(name);
      return name in this._headers;
    }

    delete(name) {
      name = normalizeHeaderName(name);
      delete this._headers[name];
    }

    *[Symbol.iterator]() {
      yield* Object.entries(this._headers);
    }
  }
  IteratorMixin.mixin(Headers);

  // https://tools.ietf.org/html/rfc7230#section-3.2.6
  const headerNameRe = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
  function normalizeHeaderName(name) {
    if (!name) {
      throw new TypeError('Invalid header name');
    }
    name = String(name).toLowerCase();
    if (!headerNameRe.test(name)) {
      throw new TypeError('Invalid header name: ' + name);
    }
    return name;
  }

  // https://tools.ietf.org/html/rfc7230#section-3.2
  const invalidHeaderValueRe = /[^\t\x20-\x7e\x80-\xff]/;
  function normalizeHeaderValue(value) {
    if (value === undefined) {
      throw new TypeError('Invalid header value');
    }
    value = String(value);
    if (invalidHeaderValueRe.test(value)) {
      throw new TypeError('Invalid header value: ' + value);
    }
    return value;
  }

  class BodyMixin {
    async arrayBuffer() {
      let bufs = [];
      const lengths = [];
      let totalLength = 0;
      for await (let buf of this.body) {
        if (typeof buf === 'string') {
          const encoder = new TextEncoder();
          buf = encoder.encode(buf).buffer;
        }
        bufs.push(buf);
        const len = buf.byteLength;
        lengths.push(len);
        totalLength += len;
      }
      const result = new Uint8Array(totalLength);
      let idx = 0;
      for (const [i, buf] of Object.entries(bufs)) {
        result.set(new Uint8Array(buf), idx);
        idx += lengths[i];
      }
      return result.buffer;
    }

    async text() {
      let result = '';
      for await (let chunk of this.body) {
        if (typeof chunk === 'object' && chunk !== null && isBufferish(chunk)) {
          const decoder = new TextDecoder();
          chunk = decoder.decode(chunk);
        }
        if (typeof chunk === 'string') {
          result += chunk;
        } else {
          result += String(chunk);
        }
      }
      return result;
    }

    async json() {
      return JSON.parse(await this.text());
    }

    static mixin(klass) {
      for (const key of Reflect.ownKeys(BodyMixin.prototype)) {
        if (key === 'constructor') {
          continue;
        }
        klass.prototype[key] = BodyMixin.prototype[key];
      }
    }
  }

  class Response {
    constructor(body, init = {}) {
      defineReadOnly(this, 'status', init.status || 200);
      defineReadOnly(this, 'statusText', init.statusText || 'OK');
      defineReadOnly(
        this,
        'headers',
        init.headers instanceof Headers
          ? init.headers
          : new Headers(init.headers)
      );
      if (body instanceof ReadableStream || body instanceof TransformStream) {
        defineReadOnly(this, 'body', body);
      } else if (typeof body === 'string') {
        defineReadOnly(this, '_bodyString', body);
      } else if (isBufferish(body)) {
        defineReadOnly(this, 'body', new StringReadable(body));
      }
    }
  }
  BodyMixin.mixin(Response);

  class Request {
    constructor(input, init = {}) {
      // TODO support `input` being a Request
      defineReadOnly(this, 'url', input);
      defineReadOnly(
        this,
        'headers',
        init.headers instanceof Headers
          ? init.headers
          : new Headers(init.headers)
      );
      defineReadOnly(this, 'method', init.method || 'GET');

      if (init.body instanceof ReadableStream || init.body instanceof self.FormData) {
        defineReadOnly(this, 'body', init.body);
      } else if (typeof init.body === 'string') {
        defineReadOnly(this, '_bodyString', init.body);
      } else if (isBufferish(init.body)) {
        defineReadOnly(this, 'body', new StringReadable(init.body));
      }
    }
  }
  BodyMixin.mixin(Request);

  class StringReadable extends ReadableStream {
    constructor(string) {
      super({
        start(controller) {
          controller.enqueue(string);
          controller.close();
        }
      });
    }
  }

  class PassThrough extends TransformStream {
    constructor() {
      super({ transform: (chunk, controller) => controller.enqueue(chunk) });
    }
  }

  {
    let timerNestingLevel = 0;

    function normalizeTimeout(timeout) {
      timeout = Number(timeout);

      return (timeout >= 0 ? timeout : 0);
    }

    // Implementation is based on the following specification:
    // https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers
    // A few adjustments/assumptions were made:
    // - The global scope will behave like a `WorkerGlobalScope`
    // - The method `HostEnsureCanCompileStrings` will throw an exception
    // - Since the WHATWG spec appears to be ambiguous about valid types for
    //   `timeout`, it will first be cast to an ECMAScript Number using the
    //   Number constructor, and then values of `NaN` will be treated as `0`
    //
    // TODO(perf): We can avoid making this function megamorphic by performing
    // typechecking in both `setInterval` and `setTimeout`, which is probably
    // worth doing if this is a hot path
    function setTimer(id, handler, timeout, nestingLevel, args, repeating) {
      timeout = normalizeTimeout(timeout);

      // Throttle timeout values
      if (nestingLevel > 5 && timeout < 4) {
        timeout = 4;
      }

      // Handler can be any type, but we don't currently support string
      // compilation, and all other non-function types will get casted to
      // strings anyway
      if (typeof handler !== 'function') {
        throw new Error('Dynamic string compilation is currently unsupported');
      }

      timerMap.set(id, () => {
        timerNestingLevel = nestingLevel + 1;
        try {
          handler.apply(null, args);
        } catch (err) {
          console.error(err && typeof err === 'object' && err.stack ? err.stack : String(err));
        }

        if (repeating) {
          setTimer(id, handler, timeout, timerNestingLevel, args, repeating);
        }

        timerNestingLevel = nestingLevel;
      });

      if (repeating && nestingLevel > 5) {
        // Micro-optimization to switch to native tokio interval handler after backoff
        repeating = false;
        setInterval(id, timeout);
      } else {
        setTimeout(id, timeout);
      }
    }

    self.setInterval = function(handler, timeout, ...args) {
      const id = timerIdCounter++;
      setTimer(id, handler, timeout, timerNestingLevel, args, true);
      return id;
    };

    self.setTimeout = function(handler, timeout, ...args) {
      const id = timerIdCounter++;
      setTimer(id, handler, timeout, timerNestingLevel, args, false);
      return id;
    };

    self.clearTimeout = self.clearInterval = function(id) {
      timerMap.delete(id);
      clearTimer(id);
    };
  }

  self.Headers = Headers;
  self.Request = Request;
  self.Response = Response;

  {
    // adapted from: https://stackoverflow.com/a/23190164
    const tableStr =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const table = tableStr.split('');

    // TODO: We should consider throwing a InvalidCharacterError/DOMException
    // This would require creating a global.DOMException property for `instanceof`
    // https://html.spec.whatwg.org/multipage/webappapis.html#atob
    self.atob = base64 => {
      if (/(=[^=]+|={3,})$/.test(base64)) {
        throw new TypeError('String contains an invalid character');
      }

      base64 = base64.replace(/=/g, '');

      const n = base64.length & 3;

      if (n === 1) {
        throw new Error('String contains an invalid character');
      }

      for (var i = 0, j = 0, len = base64.length / 4, bin = []; i < len; ++i) {
        const a = tableStr.indexOf(base64[j++] || 'A');
        const b = tableStr.indexOf(base64[j++] || 'A');
        const c = tableStr.indexOf(base64[j++] || 'A');
        const d = tableStr.indexOf(base64[j++] || 'A');

        if ((a | b | c | d) < 0) {
          throw new TypeError('String contains an invalid character');
        }

        bin[bin.length] = ((a << 2) | (b >> 4)) & 255;
        bin[bin.length] = ((b << 4) | (c >> 2)) & 255;
        bin[bin.length] = ((c << 6) | d) & 255;
      }

      return String.fromCharCode.apply(null, bin).substr(0, bin.length + n - 4);
    };

    self.btoa = bin => {
      const base64 = [];
      for (let i = 0, j = 0, len = bin.length / 3; i < len; ++i) {
        const a = bin.charCodeAt(j++),
          b = bin.charCodeAt(j++),
          c = bin.charCodeAt(j++);
        if ((a | b | c) > 255) {
          throw new TypeError('String contains an invalid character');
        }

        base64[base64.length] =
          table[a >> 2] +
          table[((a << 4) & 63) | (b >> 4)] +
          (isNaN(b) ? '=' : table[((b << 2) & 63) | (c >> 6)]) +
          (isNaN(b + c) ? '=' : table[c & 63]);
      }

      return base64.join('');
    };
  }

  {
    class FormData {

      // TODO: This could be a Map<name, [[value, filename?]]> for efficient lookups
      // However, there shouldn't be more than a dozen entries
      // Duplicate names are allowed to exist otherwise it could be a simple Map<name, [value, filename?]>
      #data = [];

      constructor(form) {
        if (form) {
          throw new TypeError("Osgood FormData doesn't support a form argument");
        }
      }

      // FormData can have duplicate entries
      append(name, value, filename) {
        if (filename) {
          // TODO: if (!(value instanceof Blob) && !(value instanceof File)) { value = String(value); }
          // TODO: There's some more logic about extracting filename from File arg, and defaulting filename to 'blob'
          throw new TypeError("Osgood currently doesn't support files");
        }

        const d = [name, value];

        // if (typeof filename !== 'undefined') {
        //   d.push(String(filename));
        // }

        this.#data.push(d);
      }

      // destroys all existing entries with same name
      set(name, value, filename) {
        this.delete(name);
        this.append(name, value, filename);
      }

      // destroys all existing entries with same name
      delete(name) {
        const new_data = [];

        for (let entry of this.#data) {
          if (entry[0] !== name) {
            new_data.push(entry);
          }
        }

        this.#data = new_data;
      }

      // get first entry of `name`
      get(name) {
        for (let entry of this.#data) {
          if (entry[0] === name) {
            return entry[1];
          }
        }
      }

      // get array of entries of `name`
      getAll(name) {
        const matches = [];

        for (let entry of this.#data) {
          if (entry[0] === name) {
            matches.push(entry[1]);
          }
        }

        return matches;
      }

      has(name) {
        for (let entry of this.#data) {
          if (entry[0] === name) {
            return true
          }
        }

        return false;
      }

      entries() {
        return this.#data[Symbol.iterator]();
      }

      [Symbol.iterator]() {
        return this.#data[Symbol.iterator]();
      }

      // iterator<key>
      *keys() {
        for (let entry of this.#data) {
          yield entry[0];
        }
      }

      // iterator<value>
      *values() {
        for (let entry of this.#data) {
          yield entry[1];
        }
      }

      // not in the spec but Firefox and Chrome have it
      forEach(fn) {
        for (let entry of this.#data) {
          fn(entry[0], entry[1], this);
        }
      }

      toString() {
        return '[object FormData]';
      }
    }

    self.FormData = FormData;
  }

  // https://tools.ietf.org/html/rfc1867
  // https://www.w3.org/Protocols/rfc1341/7_2_Multipart.html#z0
  function generateMultipartFormData(formData) {
    const boundary = `--------------OsgoodFormBoundary${Math.floor(Math.random() * 899999999) + 100000000}`;

    let body = '';

    for (let entry of formData) {
      if (entry[2]) {
        throw new TypeError("Osgood currently doesn't support files");
      }
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="${entry[0]}"\r\n`;
      body += `\r\n`;
      body += `${entry[1]}\r\n`;
    }

    body += `--${boundary}--\r\n`;

    return {
      body,
      boundary,
      contentType: `multipart/form-data; boundary=${boundary}`
    };
  }
}
