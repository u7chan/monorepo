export function getHello(_req: Request): Response {
  return Response.json({
    message: "Hello, world!",
    method: "GET",
  });
}

export function putHello(_req: Request): Response {
  return Response.json({
    message: "Hello, world!",
    method: "PUT",
  });
}

export interface HelloNameParams {
  name: string;
}

export function getHelloByName(_req: Request, params: HelloNameParams): Response {
  return Response.json({
    message: `Hello, ${params.name}!`,
  });
}
