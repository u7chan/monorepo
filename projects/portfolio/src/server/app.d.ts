type Env = {
    NODE_ENV?: string;
    SERVER_PORT?: string;
};
type HonoEnv = {
    Bindings: Env;
};
declare const app: import('hono/hono-base').HonoBase<HonoEnv, {
    "/api/profile": {
        $post: {
            input: {
                form: {
                    name: string;
                    email: string;
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
                    messages: ({
                        role: "system";
                        content: string;
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "user";
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
                    })[];
                    model: string;
                    stream?: boolean | undefined;
                    temperature?: number | undefined;
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
                    messages: ({
                        role: "system";
                        content: string;
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "user";
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
                    })[];
                    model: string;
                    stream?: boolean | undefined;
                    temperature?: number | undefined;
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
