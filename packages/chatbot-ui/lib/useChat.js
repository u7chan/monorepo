var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import "./useTheme.js";
var _serialize = (name, value, opt = {}) => {
  let cookie = `${name}=${value}`;
  if (name.startsWith("__Secure-") && !opt.secure) {
    throw new Error("__Secure- Cookie must have Secure attributes");
  }
  if (name.startsWith("__Host-")) {
    if (!opt.secure) {
      throw new Error("__Host- Cookie must have Secure attributes");
    }
    if (opt.path !== "/") {
      throw new Error('__Host- Cookie must have Path attributes with "/"');
    }
    if (opt.domain) {
      throw new Error("__Host- Cookie must not have Domain attributes");
    }
  }
  if (opt && typeof opt.maxAge === "number" && opt.maxAge >= 0) {
    if (opt.maxAge > 3456e4) {
      throw new Error(
        "Cookies Max-Age SHOULD NOT be greater than 400 days (34560000 seconds) in duration."
      );
    }
    cookie += `; Max-Age=${opt.maxAge | 0}`;
  }
  if (opt.domain && opt.prefix !== "host") {
    cookie += `; Domain=${opt.domain}`;
  }
  if (opt.path) {
    cookie += `; Path=${opt.path}`;
  }
  if (opt.expires) {
    if (opt.expires.getTime() - Date.now() > 3456e7) {
      throw new Error(
        "Cookies Expires SHOULD NOT be greater than 400 days (34560000 seconds) in the future."
      );
    }
    cookie += `; Expires=${opt.expires.toUTCString()}`;
  }
  if (opt.httpOnly) {
    cookie += "; HttpOnly";
  }
  if (opt.secure) {
    cookie += "; Secure";
  }
  if (opt.sameSite) {
    cookie += `; SameSite=${opt.sameSite.charAt(0).toUpperCase() + opt.sameSite.slice(1)}`;
  }
  if (opt.priority) {
    cookie += `; Priority=${opt.priority}`;
  }
  if (opt.partitioned) {
    if (!opt.secure) {
      throw new Error("Partitioned Cookie must have Secure attributes");
    }
    cookie += "; Partitioned";
  }
  return cookie;
};
var serialize = (name, value, opt) => {
  value = encodeURIComponent(value);
  return _serialize(name, value, opt);
};
var mergePath = (base, path) => {
  base = base.replace(/\/+$/, "");
  base = base + "/";
  path = path.replace(/^\/+/, "");
  return base + path;
};
var replaceUrlParam = (urlString, params) => {
  for (const [k, v] of Object.entries(params)) {
    const reg = new RegExp("/:" + k + "(?:{[^/]+})?\\??");
    urlString = urlString.replace(reg, v ? `/${v}` : "");
  }
  return urlString;
};
var buildSearchParams = (query) => {
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === void 0) {
      continue;
    }
    if (Array.isArray(v)) {
      for (const v2 of v) {
        searchParams.append(k, v2);
      }
    } else {
      searchParams.set(k, v);
    }
  }
  return searchParams;
};
var replaceUrlProtocol = (urlString, protocol) => {
  switch (protocol) {
    case "ws":
      return urlString.replace(/^http/, "ws");
    case "http":
      return urlString.replace(/^ws/, "http");
  }
};
var removeIndexString = (urlSting) => {
  if (/^https?:\/\/[^\/]+?\/index$/.test(urlSting)) {
    return urlSting.replace(/\/index$/, "/");
  }
  return urlSting.replace(/\/index$/, "");
};
function isObject(item) {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}
function deepMerge(target, source) {
  if (!isObject(target) && !isObject(source)) {
    return source;
  }
  const merged = { ...target };
  for (const key in source) {
    const value = source[key];
    if (isObject(merged[key]) && isObject(value)) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
var createProxy = (callback, path) => {
  const proxy = new Proxy(() => {
  }, {
    get(_obj, key) {
      if (typeof key !== "string" || key === "then") {
        return void 0;
      }
      return createProxy(callback, [...path, key]);
    },
    apply(_1, _2, args) {
      return callback({
        path,
        args
      });
    }
  });
  return proxy;
};
var ClientRequestImpl = class {
  constructor(url, method) {
    __publicField(this, "url");
    __publicField(this, "method");
    __publicField(this, "queryParams");
    __publicField(this, "pathParams", {});
    __publicField(this, "rBody");
    __publicField(this, "cType");
    __publicField(this, "fetch", async (args, opt) => {
      if (args) {
        if (args.query) {
          this.queryParams = buildSearchParams(args.query);
        }
        if (args.form) {
          const form = new FormData();
          for (const [k, v] of Object.entries(args.form)) {
            if (Array.isArray(v)) {
              for (const v2 of v) {
                form.append(k, v2);
              }
            } else {
              form.append(k, v);
            }
          }
          this.rBody = form;
        }
        if (args.json) {
          this.rBody = JSON.stringify(args.json);
          this.cType = "application/json";
        }
        if (args.param) {
          this.pathParams = args.param;
        }
      }
      let methodUpperCase = this.method.toUpperCase();
      const headerValues = {
        ...args == null ? void 0 : args.header,
        ...typeof (opt == null ? void 0 : opt.headers) === "function" ? await opt.headers() : opt == null ? void 0 : opt.headers
      };
      if (args == null ? void 0 : args.cookie) {
        const cookies = [];
        for (const [key, value] of Object.entries(args.cookie)) {
          cookies.push(serialize(key, value, { path: "/" }));
        }
        headerValues["Cookie"] = cookies.join(",");
      }
      if (this.cType) {
        headerValues["Content-Type"] = this.cType;
      }
      const headers = new Headers(headerValues ?? void 0);
      let url = this.url;
      url = removeIndexString(url);
      url = replaceUrlParam(url, this.pathParams);
      if (this.queryParams) {
        url = url + "?" + this.queryParams.toString();
      }
      methodUpperCase = this.method.toUpperCase();
      const setBody = !(methodUpperCase === "GET" || methodUpperCase === "HEAD");
      return ((opt == null ? void 0 : opt.fetch) || fetch)(url, {
        body: setBody ? this.rBody : void 0,
        method: methodUpperCase,
        headers,
        ...opt == null ? void 0 : opt.init
      });
    });
    this.url = url;
    this.method = method;
  }
};
var hc = (baseUrl, options) => createProxy(function proxyCallback(opts) {
  var _a;
  const parts = [...opts.path];
  const lastParts = parts.slice(-3).reverse();
  if (lastParts[0] === "toString") {
    if (lastParts[1] === "name") {
      return lastParts[2] || "";
    }
    return proxyCallback.toString();
  }
  if (lastParts[0] === "valueOf") {
    if (lastParts[1] === "name") {
      return lastParts[2] || "";
    }
    return proxyCallback;
  }
  let method = "";
  if (/^\$/.test(lastParts[0])) {
    const last = parts.pop();
    if (last) {
      method = last.replace(/^\$/, "");
    }
  }
  const path = parts.join("/");
  const url = mergePath(baseUrl, path);
  if (method === "url") {
    let result = url;
    if (opts.args[0]) {
      if (opts.args[0].param) {
        result = replaceUrlParam(url, opts.args[0].param);
      }
      if (opts.args[0].query) {
        result = result + "?" + buildSearchParams(opts.args[0].query).toString();
      }
    }
    return new URL(result);
  }
  if (method === "ws") {
    const webSocketUrl = replaceUrlProtocol(
      opts.args[0] && opts.args[0].param ? replaceUrlParam(url, opts.args[0].param) : url,
      "ws"
    );
    const targetUrl = new URL(webSocketUrl);
    const queryParams = (_a = opts.args[0]) == null ? void 0 : _a.query;
    if (queryParams) {
      Object.entries(queryParams).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          value.forEach((item) => targetUrl.searchParams.append(key, item));
        } else {
          targetUrl.searchParams.set(key, value);
        }
      });
    }
    const establishWebSocket = (...args) => {
      if ((options == null ? void 0 : options.webSocket) !== void 0 && typeof options.webSocket === "function") {
        return options.webSocket(...args);
      }
      return new WebSocket(...args);
    };
    return establishWebSocket(targetUrl.toString());
  }
  const req = new ClientRequestImpl(url, method);
  if (method) {
    options ?? (options = {});
    const args = deepMerge(options, { ...opts.args[1] });
    return req.fetch(opts.args[0], args);
  }
  return req;
}, []);
hc("/");
//# sourceMappingURL=useChat.js.map
