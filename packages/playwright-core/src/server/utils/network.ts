/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


import http from 'http';
import http2 from 'http2';
import https from 'https';
import url from 'url';

import { HttpsProxyAgent, SocksProxyAgent, getProxyForUrl } from '../../utilsBundle';
import { httpHappyEyeballsAgent, httpsHappyEyeballsAgent } from './happyEyeballs';

import type net from 'net';
import type { ProxySettings } from '../types';
import type { Progress } from '../progress';

export type HTTPRequestParams = {
  url: string,
  method?: string,
  headers?: http.OutgoingHttpHeaders,
  data?: string | Buffer,
  rejectUnauthorized?: boolean,
  socketTimeout?: number,
};

export const NET_DEFAULT_TIMEOUT = 30_000;

export function httpRequest(params: HTTPRequestParams, onResponse: (r: http.IncomingMessage) => void, onError: (error: Error) => void): { cancel(error: Error | undefined): void } {
  const parsedUrl = new URL(params.url);
  const options: https.RequestOptions = {
    agent: parsedUrl.protocol === 'https:' ? httpsHappyEyeballsAgent : httpHappyEyeballsAgent,
    method: params.method || 'GET',
    headers: params.headers,
  };
  if (params.rejectUnauthorized !== undefined)
    options.rejectUnauthorized = params.rejectUnauthorized;

  const proxyURL = getProxyForUrl(params.url);
  if (proxyURL) {
    const parsedProxyURL = new URL(proxyURL);
    if (params.url.startsWith('http:')) {
      parsedUrl.pathname = parsedUrl.href;
      parsedUrl.host = parsedProxyURL.host;
    } else {
      options.agent = new HttpsProxyAgent({
        ...convertURLtoLegacyUrl(parsedProxyURL),
        secureProxy: parsedProxyURL.protocol === 'https:',
      });
      options.rejectUnauthorized = false;
    }
  }

  let cancelRequest: (e: Error | undefined) => void;
  const requestCallback = (res: http.IncomingMessage) => {
    const statusCode = res.statusCode || 0;
    if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
      // Close the original socket before following the redirect. Otherwise
      // it may stay idle and cause a timeout error.
      request.destroy();
      cancelRequest = httpRequest({ ...params, url: new URL(res.headers.location, params.url).toString() }, onResponse, onError).cancel;
    } else {
      onResponse(res);
    }
  };
  const request = options.protocol === 'https:' ?
    https.request(parsedUrl, options, requestCallback) :
    http.request(parsedUrl, options, requestCallback);
  request.on('error', onError);
  if (params.socketTimeout !== undefined) {
    request.setTimeout(params.socketTimeout, () =>  {
      onError(new Error(`Request to ${params.url} timed out after ${params.socketTimeout}ms`));
      request.abort();
    });
  }
  cancelRequest = e => request.destroy(e);
  request.end(params.data);
  return { cancel: e => cancelRequest(e) };
}

export function fetchData(progress: Progress | undefined, params: HTTPRequestParams, onError?: (params: HTTPRequestParams, response: http.IncomingMessage) => Promise<Error>): Promise<string> {
  const promise = new Promise<string>((resolve, reject) => {
    const { cancel } = httpRequest(params, async response => {
      if (response.statusCode !== 200) {
        const error = onError ? await onError(params, response) : new Error(`fetch failed: server returned code ${response.statusCode}. URL: ${params.url}`);
        reject(error);
        return;
      }
      let body = '';
      response.on('data', (chunk: string) => body += chunk);
      response.on('error', (error: any) => reject(error));
      response.on('end', () => resolve(body));
    }, reject);
    progress?.cleanupWhenAborted(cancel);
  });
  return progress ? progress.race(promise) : promise;
}

function shouldBypassProxy(url: URL, bypass?: string): boolean {
  if (!bypass)
    return false;
  const domains = bypass.split(',').map(s => {
    s = s.trim();
    if (!s.startsWith('.'))
      s = '.' + s;
    return s;
  });
  const domain = '.' + url.hostname;
  return domains.some(d => domain.endsWith(d));
}

export function createProxyAgent(proxy?: ProxySettings, forUrl?: URL) {
  if (!proxy)
    return;
  if (forUrl && proxy.bypass && shouldBypassProxy(forUrl, proxy.bypass))
    return;

  // Browsers allow to specify proxy without a protocol, defaulting to http.
  let proxyServer = proxy.server.trim();
  if (!/^\w+:\/\//.test(proxyServer))
    proxyServer = 'http://' + proxyServer;

  const proxyOpts = new URL(proxyServer);
  if (proxyOpts.protocol?.startsWith('socks')) {
    return new SocksProxyAgent({
      host: proxyOpts.hostname,
      port: proxyOpts.port || undefined,
    });
  }
  if (proxy.username) {
    proxyOpts.username = proxy.username;
    proxyOpts.password = proxy.password || '';
  }

  if (forUrl && ['ws:', 'wss:'].includes(forUrl.protocol)) {
    // Force CONNECT method for WebSockets.
    // TODO: switch to URL instance instead of legacy object once https-proxy-agent supports it.
    return new HttpsProxyAgent(convertURLtoLegacyUrl(proxyOpts));
  }

  // TODO: We should use HttpProxyAgent conditional on proxyOpts.protocol instead of always using CONNECT method.
  // TODO: switch to URL instance instead of legacy object once https-proxy-agent supports it.
  return new HttpsProxyAgent(convertURLtoLegacyUrl(proxyOpts));
}

export function createHttpServer(requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void): http.Server;
export function createHttpServer(options: http.ServerOptions, requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void): http.Server;
export function createHttpServer(...args: any[]): http.Server {
  const server = http.createServer(...args);
  decorateServer(server);
  return server;
}

export function createHttpsServer(requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void): https.Server;
export function createHttpsServer(options: https.ServerOptions, requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void): https.Server;
export function createHttpsServer(...args: any[]): https.Server {
  const server = https.createServer(...args);
  decorateServer(server);
  return server;
}

export function createHttp2Server(onRequestHandler?: (request: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => void,): http2.Http2SecureServer;
export function createHttp2Server(options: http2.SecureServerOptions, onRequestHandler?: (request: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => void,): http2.Http2SecureServer;
export function createHttp2Server(...args: any[]): http2.Http2SecureServer {
  const server = http2.createSecureServer(...args);
  decorateServer(server);
  return server;
}

export async function isURLAvailable(url: URL, ignoreHTTPSErrors: boolean, onLog?: (data: string) => void, onStdErr?: (data: string) => void) {
  let statusCode = await httpStatusCode(url, ignoreHTTPSErrors, onLog, onStdErr);
  if (statusCode === 404 && url.pathname === '/') {
    const indexUrl = new URL(url);
    indexUrl.pathname = '/index.html';
    statusCode = await httpStatusCode(indexUrl, ignoreHTTPSErrors, onLog, onStdErr);
  }
  return statusCode >= 200 && statusCode < 404;
}

async function httpStatusCode(url: URL, ignoreHTTPSErrors: boolean, onLog?: (data: string) => void, onStdErr?: (data: string) => void): Promise<number> {
  return new Promise(resolve => {
    onLog?.(`HTTP GET: ${url}`);
    httpRequest({
      url: url.toString(),
      headers: { Accept: '*/*' },
      rejectUnauthorized: !ignoreHTTPSErrors
    }, res => {
      res.resume();
      const statusCode = res.statusCode ?? 0;
      onLog?.(`HTTP Status: ${statusCode}`);
      resolve(statusCode);
    }, error => {
      if ((error as NodeJS.ErrnoException).code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
        onStdErr?.(`[WebServer] Self-signed certificate detected. Try adding ignoreHTTPSErrors: true to config.webServer.`);
      onLog?.(`Error while checking if ${url} is available: ${error.message}`);
      resolve(0);
    });
  });
}

function decorateServer(server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const close = server.close;
  server.close = (callback?: (err?: Error) => void) => {
    for (const socket of sockets)
      socket.destroy();
    sockets.clear();
    return close.call(server, callback);
  };
}

function convertURLtoLegacyUrl(url: URL): url.Url {
  return {
    auth: url.username ? url.username + ':' + url.password : null,
    hash: url.hash || null,
    host: url.hostname ? url.hostname + ':' + url.port : null,
    hostname: url.hostname || null,
    href: url.href,
    path: url.pathname + url.search,
    pathname: url.pathname,
    protocol: url.protocol,
    search: url.search || null,
    slashes: true,
    port: url.port || null,
    query: url.search.slice(1) || null,
  };
}
