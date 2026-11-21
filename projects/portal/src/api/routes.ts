import { listContainers, postContainerAction } from "./containers";
import { getConfig } from "./config";
import { getDeployOptions, postDeployment } from "./deployments";
import { getHello, getHelloByName, putHello } from "./health";

type ApiPath =
  | "/api/containers"
  | "/api/containers/:id/:action"
  | "/api/containers/:id/deploy-options"
  | "/api/deployments"
  | "/api/hello"
  | "/api/hello/:name"
  | "/api/config";

export const apiRoutes = {
  "/api/containers": {
    GET: listContainers,
  },
  "/api/containers/:id/:action": {
    POST: (req) => postContainerAction(req, req.params),
  },
  "/api/containers/:id/deploy-options": {
    GET: (req) => getDeployOptions(req, req.params),
  },
  "/api/deployments": {
    POST: postDeployment,
  },
  "/api/hello": {
    GET: getHello,
    PUT: putHello,
  },
  "/api/hello/:name": (req) => getHelloByName(req, req.params),
  "/api/config": {
    GET: getConfig,
  },
} satisfies Bun.Serve.Routes<unknown, ApiPath>;
