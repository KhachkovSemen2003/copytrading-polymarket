import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

/**
 * Configures axios to use a proxy if PROXY_URL, HTTP_PROXY, or HTTPS_PROXY
 * environment variables are set.
 *
 * Supported proxy formats:
 * - http://host:port
 * - http://user:pass@host:port
 * - socks5://host:port
 * - socks5://user:pass@host:port
 */
export function setupProxy(proxyUrl?: string): void {
  const url = proxyUrl || process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;

  if (!url) {
    return;
  }

  console.log(`[Proxy] Configuring proxy: ${url.replace(/\/\/.*@/, "//***@")}`);

  try {
    if (url.startsWith("socks5://")) {
      const agent = new SocksProxyAgent(url);
      axios.defaults.httpsAgent = agent;
      axios.defaults.httpAgent = agent;
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      const agent = new HttpsProxyAgent(url);
      axios.defaults.httpsAgent = agent;
      axios.defaults.httpAgent = agent;
    } else {
      console.warn(`[Proxy] Unsupported proxy protocol in URL: ${url}`);
      return;
    }

    // Ensure axios uses the agent for all requests
    axios.defaults.proxy = false;
  } catch (err) {
    console.error(`[Proxy] Failed to configure proxy: ${err}`);
    throw err;
  }
}
