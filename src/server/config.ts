/** CLI-argument-based server configuration. */

export interface ServerConfig {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  authToken: string;
  port: number;
  enableThinking: boolean;
  dumpDir: string;
}

function parseArgs(): ServerConfig {
  const args = Bun.argv;
  const getArg = (name: string, fallback: string): string => {
    const flag = `--${name}`;
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    const eqFlag = `${flag}=`;
    const eqArg = args.find((a) => a.startsWith(eqFlag));
    if (eqArg) return eqArg.slice(eqFlag.length);
    return fallback;
  };

  const getBool = (name: string, fallback: boolean): boolean => {
    const flag = `--${name}`;
    if (args.includes(flag)) return true;
    const noFlag = `--no-${name}`;
    if (args.includes(noFlag)) return false;
    const eqFlag = `--${name}=`;
    const eqArg = args.find((a) => a.startsWith(eqFlag));
    if (eqArg) return eqArg.slice(eqFlag.length) !== "false";
    return fallback;
  };

  return {
    upstreamBaseUrl: getArg("upstream-base-url", "https://api.openai.com/v1"),
    upstreamApiKey: getArg("upstream-api-key", ""),
    authToken: getArg("auth-token", ""),
    port: parseInt(getArg("port", "8082"), 10),
    enableThinking: getBool("enable-thinking", true),
    dumpDir: getArg("dump", ""),
  };
}

export const loadConfig = parseArgs;
