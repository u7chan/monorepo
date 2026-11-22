import { listContainers, postContainerAction } from "./containers";
import { getConfig } from "./config";
import { getDeployOptions, postDeployment } from "./deployments";
import { getHello, getHelloByName, putHello } from "./health";
import { getImageUpdates } from "./imageUpdates";

type ApiPath =
  | "/api/containers"
  | "/api/containers/:id/:action"
  | "/api/containers/:id/deploy-options"
  | "/api/deployments"
  | "/api/image-updates"
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
    POST: (req) => postDeployment(req),
  },
  "/api/image-updates": {
    GET: (req) => getImageUpdates(req),
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
