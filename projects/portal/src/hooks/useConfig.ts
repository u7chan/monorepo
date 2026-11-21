// Config Hook - アプリケーション設定を取得

import { useState, useEffect } from "react";
import { readStatusError, requestJson } from "../lib/apiClient";

interface Config {
  host: string;
  isMockMode: boolean;
}

interface ConfigState {
  config: Config | null;
  loading: boolean;
  error: string | null;
}

export function useConfig(): ConfigState {
  const [state, setState] = useState<ConfigState>({
    config: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const data = (await requestJson(
          "/api/config",
          undefined,
          (status) => `HTTP error! status: ${status}`,
          { readError: readStatusError },
        )) as Partial<Config>;

        setState({
          config: {
            host: data.host || "localhost",
            isMockMode: data.isMockMode || false,
          },
          loading: false,
          error: null,
        });
      } catch (error) {
        console.error("Failed to fetch config:", error);
        setState({
          config: { host: "localhost", isMockMode: false },
          loading: false,
          error: error instanceof Error ? error.message : "Failed to fetch config",
        });
      }
    };

    fetchConfig();
  }, []);

  return state;
}

export default useConfig;
