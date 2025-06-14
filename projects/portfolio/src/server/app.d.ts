type Env = {
    NODE_ENV?: string;
    SERVER_PORT?: string;
    COOKIE_SECRET?: string;
    COOKIE_NAME?: string;
    COOKIE_EXPIRES?: string;
};
type HonoEnv = {
    Bindings: Env;
};
declare const app: import('hono/hono-base').HonoBase<HonoEnv, {
    "api/signin": {
        $post: {
            input: {
                json: {
                    email: string;
                    password: string;
                };
            };
            output: {};
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/profile": {
        $post: {
            input: {
                form: {
                    email: string;
                    name: string;
                };
            };
            output: {
                name: string;
                email: string;
                updated_at: string;
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/chat": {
        $post: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                    'mcp-server-urls': string;
                };
            } & {
                json: {
                    model: string;
                    messages: ({
                        content: string;
                        role: "system";
                    } | {
                        content: string;
                        role: "assistant";
                    } | {
                        content: string | ({
                            type: "text";
                            text: string;
                        } | {
                            type: "image_url";
                            image_url: {
                                url: string;
                                detail?: "auto" | "low" | "high" | undefined;
                            };
                        })[];
                        role: "user";
                    })[];
                    temperature?: number | undefined;
                    stream?: boolean | undefined;
                    max_tokens?: number | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
} & {
    "/api/chat/completions": {
        $post: {
            input: {
                json: {
                    model: string;
                    messages: ({
                        content: string;
                        role: "system";
                    } | {
                        content: string;
                        role: "assistant";
                    } | {
                        content: string | ({
                            type: "text";
                            text: string;
                        } | {
                            type: "image_url";
                            image_url: {
                                url: string;
                                detail?: "auto" | "low" | "high" | undefined;
                            };
                        })[];
                        role: "user";
                    })[];
                    temperature?: number | undefined;
                    stream?: boolean | undefined;
                    max_tokens?: number | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
} & {
    "*": {
        $get: {
            input: {};
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
}, "/">;
export type AppType = typeof app;
export default app;
