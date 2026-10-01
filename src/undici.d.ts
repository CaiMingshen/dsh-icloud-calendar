/**
 * `undici` is an optional dependency: it is imported only when `proxyUrl` is
 * set, so a profile without a proxy never needs it. Declaring the one member
 * this plugin uses keeps the type check honest without forcing the install.
 */
declare module 'undici' {
  export class ProxyAgent {
    constructor(options: string | Record<string, unknown>)
  }
}
