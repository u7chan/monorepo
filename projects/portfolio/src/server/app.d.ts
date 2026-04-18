import { HonoEnv } from './routes/shared';
declare const app: import('hono/hono-base').HonoBase<HonoEnv, import('hono/types').BlankSchema, "/", "*">;
declare const routes: import('hono/hono-base').HonoBase<HonoEnv, import('hono/types').BlankSchema | import('hono/types').MergeSchemaPath<{
    "/api/signin": {
        $post: {
            input: {
                json: {
                    email: string;
                    password: string;
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: any;
            };
            outputFormat: "json";
            status: 400;
        } | {
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
    "/api/signout": {
        $post: {
            input: {};
            output: {};
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
}, "/"> | import('hono/types').MergeSchemaPath<{
    "/api/chat": {
        $post: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                error: string;
                code: "VALIDATION_ERROR";
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                error: string;
                code: "VALIDATION_ERROR";
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                id: string;
                created: number;
                model: string;
                finishReason: string;
                message: {
                    content: string;
                    reasoningContent: string;
                };
                usage: {
                    promptTokens: number;
                    completionTokens: number;
                    totalTokens: number;
                    reasoningTokens?: number | undefined;
                } | null;
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                error: string;
                code: "UPSTREAM_ERROR";
            };
            outputFormat: "json";
            status: 502;
        };
    };
} & {
    "/api/chat/stream": {
        $post: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                error: string;
                code: "VALIDATION_ERROR";
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                error: string;
                code: "VALIDATION_ERROR";
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
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
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
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
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: any;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
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
}, "/"> | import('hono/types').MergeSchemaPath<{
    "/api/conversations": {
        $get: {
            input: {};
            output: {
                data: {
                    id: string;
                    title: string;
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                        reasoningContent: string;
                        metadata: {
                            model: string;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                        };
                        id?: string | undefined;
                    } | {
                        role: "assistant";
                        content: string;
                        metadata: {
                            model: string;
                            usage: {
                                completionTokens?: number | undefined;
                                promptTokens?: number | undefined;
                                totalTokens?: number | undefined;
                                reasoningTokens?: number | undefined;
                            };
                            finishReason?: string | undefined;
                            responseTimeMs?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        reasoningContent: string;
                        id?: string | undefined;
                        metadata?: {} | undefined;
                    })[];
                    updatedAt?: string | undefined;
                }[];
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/conversations": {
        $post: {
            input: {
                json: {
                    id: string;
                    title: string;
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                        metadata: {
                            model: string;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "assistant";
                        content: string;
                        metadata: {
                            model: string;
                            usage: {
                                completionTokens?: number | undefined;
                                promptTokens?: number | undefined;
                                totalTokens?: number | undefined;
                                reasoningTokens?: number | undefined;
                            };
                            finishReason?: string | undefined;
                            responseTimeMs?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                        metadata?: Record<string, never> | undefined;
                    })[];
                    updatedAt?: unknown;
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: any;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    id: string;
                    title: string;
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                        metadata: {
                            model: string;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "assistant";
                        content: string;
                        metadata: {
                            model: string;
                            usage: {
                                completionTokens?: number | undefined;
                                promptTokens?: number | undefined;
                                totalTokens?: number | undefined;
                                reasoningTokens?: number | undefined;
                            };
                            finishReason?: string | undefined;
                            responseTimeMs?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                        metadata?: Record<string, never> | undefined;
                    })[];
                    updatedAt?: unknown;
                };
            };
            output: {
                conversationId: string;
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/conversations": {
        $delete: {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: Record<string, string | string[]>;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                success: boolean;
                deletedIds: string[];
                failedIds: string[];
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/conversations/messages": {
        $delete: {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: Record<string, string | string[]>;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                success: boolean;
                deletedMessageIds: string[];
                failedMessageIds: string[];
                deletedConversationIds: string[];
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
}, "/"> | import('hono/types').MergeSchemaPath<{
    "/api/fetch-models": {
        $get: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            };
            output: string[];
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
}, "/"> | import('hono/types').MergeSchemaPath<{
    "*": {
        $get: {
            input: {};
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
}, "/">, "/", "*">;
export type AppType = typeof routes;
export default app;
