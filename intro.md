# fishenv.http

A HTTP server/library built with Deno and TypeScript. It is designed to be simple, efficient, and easy to use for building web applications and APIs.

It is an opinionated framework that provides a set of tools and conventions for building web applications, while still allowing for flexibility and customization.
The main features of `fishenv.http` include:

- Routing: A simple and intuitive routing system for defining endpoints and handling requests.
- Middleware: Support for middleware functions that can be used to modify requests and responses, handle authentication, and perform other tasks.
- Request and Response Handling: A straightforward API for working with HTTP requests and responses, including support for JSON, form data, and file uploads.
- Error Handling: Built-in error handling mechanisms to help manage and respond to errors in a consistent way.
- Performance: Designed for high performance, with efficient handling of requests and responses, and support for asynchronous operations.
  Overall, `fishenv.http` aims to provide a solid foundation for building web applications and APIs with Deno, while keeping the development process simple and enjoyable.

# Routing

The routing system in `fishenv.http` allows you to define endpoints and handle requests in a straightforward way.
You can define routes for different HTTP methods (GET, POST, PUT, DELETE, etc.) and specify the path for each route.
The routing system also supports route parameters, query parameters, and middleware functions that can be applied to specific routes or groups of routes.

Grouping should be possible by using a `Router` class that allows you to define a group of routes with a common path prefix and shared middleware.
This can help to organize your routes and apply middleware to multiple routes at once.

```typescript
import { r } from "fishenv.http";

const router = r({
  prefix: "/api",
});

// Apply middleware to all routes in this router
router.use(SomeMiddleware);
router.use(AnotherMiddleware);

// /api/users
router.get("/");
router.post("/");
router.put("/");

const user = router.extend({
  prefix: "/",
});

user.use(UserSpecificMiddleware);

// /api/users/:id
user.get("/:id");

route
  .post("/abc")
  .with(SomeMiddleware)
  .input({ body: SomeSchema, headers: AnotherSchema, query: YetAnotherSchema })
  .handle(({ request, path, ctx, body, headers, query }) => {
    // Handle POST /api/abc
    return new Response("Hello, World!");
  });

route
  .post("/abc/:id") // <-- id is part of the path
  .param("id", StringSchema) // <-- id is inferred from the path
  .input("blob", { maxSize: 10 * 1024 * 1024 }) // 10MB
  .with(SomeMiddleware)
  .handle(({ req, path, ctx, headers, body }) => {
    // Handle POST /api/abs
  });

route
  .post("/abc")
  .meta({
    title: "Create ABC",
    description: "This is the endpoint for creating a new abc resource",
  }) // <-- add metadata to the route, which can be used for documentation or other purposes
  .with(SomeMiddleware)
  .with(AnotherMiddleware)
  .input("json", {
    body: SomeSchema,
    headers: AnotherSchema,
    query: YetAnotherSchema,
    cookies: CookieSchema,
  }) // <-- specify the input schema for the route, which will be used for validation and type inference (e.g., body is validated against SomeSchema, headers are validated against AnotherSchema, etc.)
  .output(SomeOutputSchema, [BadRequestError, UnauthorizedError]) // <-- specify the output schema for the route, which will be used for validation and type inference of the response (e.g., the response must match SomeOutputSchema) Error types are only for documentation.
  .handle(
    // Handle is the last method in the chain, only catch can come after handle.
    ({
      req, // request object, which can be used to access the raw request data, such as the body, headers, etc.a
      path, // path parameters, which are extracted from the URL based on the route definition (e.g., if the route is defined as /abc/:id, then path.id would contain the value of the id parameter from the URL)
      ctx, // context object, which is a shared object that can be used to store data and pass it between middleware and route handlers (e.g., if a middleware function adds a user object to the context, then it would be available in the route handler as ctx.user)
      headers, // headers from the request, which can be used to access specific header values (e.g., headers["content-type"] would give you the value of the Content-Type header)
      body, // body of the request, which can be accessed in different formats depending on the content type (e.g., if the content type is application/json, then body would contain the parsed JSON object)
      container, // dependency injection container, which can be used to resolve dependencies and access services (e.g., if you have a service called AbcUseCase registered in the container, you can resolve it with container.get(AbcUseCase) and use it in your route handler)
    }) => {
      // With output specified the return value of the handle must match, or else it will give type error.
      return container.get(AbcUseCase).execute(body.blob);
    },
  );

/// Typesafe input variants

// Json body input with schema validation, if no schema is provided, it will be inferred as unknown
route.post("/abc").input("json", { body: SomeSchema });
route.post("/abc").input("multipart", { body: SomeSchema });
route.post("/abc").input("urlencoded", { body: SomeSchema });
route.post("/abc").handle(); // If input is omitted it will be inferred as unknown, so body would be unknown in this case.

// Type inference

const api = r({
  prefix: "/api",
})
  .use(SomeMiddleware) // <-- returned type from middleware is inferred and applied to context (if this returns {user: User}, ctx will be inferred as {user: User})
  .use(AnotherMiddleware); // <-- returned type from middleware is inferred and applied to context (if this returns {auth: Auth}, ctx will be inferred as {user: User, auth: Auth})

api.get("/users/:id").handle(({ req, path, ctx }) => {
  const { id } = path; // id is inferred as string (unless you specify a different schema for it with .param("id", NumberSchema), then it would be inferred and validated as number)
  // ctx is inferred as {user: User, auth: Auth}
  const { user, auth } = ctx;
  // Handle GET /api/users
});
```

# Error Handling

`fishenv.http` provides built-in error handling mechanisms to help manage and respond to errors in a consistent way.

A route can have a error handler defined with the `catch` method, which will catch any errors thrown in the route handler or middleware and allow you to handle them gracefully.

````typescript
route
  .post("/abc")
  .handle(({ req, path, ctx }) => {
    // Handle POST /abc
    throw new Error("Something went wrong!"); // This error will be caught by the catch handler defined below
  })
  .catch((err, { req, path, ctx }) => {
    // This will catch any errors thrown in the route handler or middleware for this route
    console.error("Error occurred:", err);
    return new Response("An error occurred while processing your request.", { status: 500 });
  })

Error handlers can also be defined globally for the entire application, allowing you to catch and handle errors that occur in any route or middleware.
Errors are handled at the first level they are caught, so if you have a route-specific error handler, it will catch errors for that route before they propagate to the global error handler.

# Middleware

Middleware functions in `fishenv.http` are functions that can be used to modify requests and responses, handle authentication, and perform other tasks before the request reaches the route handler.
Middleware can be applied globally to all routes, or to specific routes or groups of routes using the `use` method on the router or route definition.
Middleware functions receive the request, response, and context objects as parameters, and can modify them as needed before passing control to the next middleware or route handler in the chain.

# Interceptors

Interceptors are similar to middleware, but they are designed to be used after the route handler has executed, allowing you to modify the response before it is sent back to the client.
Interceptors can be applied globally or to specific routes, and they receive the response object and context as parameters, allowing you to modify the response or perform additional tasks before the response is sent back to the client.

```typescript
function beforeInterceptor({ req, path, ctx }) {
  // This interceptor will run before the route handler is executed, allowing you to modify the request or context before it reaches the route handler.
}

function afterInterceptor({ res, ctx }) {
  // This interceptor will run after the route handler has executed, allowing you to modify the response before it is sent back to the client.
}

route
  .intercept(
    beforeInterceptor, // <-- this interceptor will run before the route handler is executed
    afterInterceptor, // <-- this interceptor will run after the route handler has executed
  )
  .post("/abc");
````

# Dependency Injection

`fishenv.http` includes support for dependency injection, allowing you to manage and resolve dependencies in a clean and efficient way.
You can define services and register them in a dependency injection container, which can then be accessed in your route handlers and middleware using the context object.
This will be implemented with another fishenv library, `fishenv.di`, which will provide a simple and intuitive API for defining and managing dependencies in your application.

# Websockets

`fishenv.http` also includes support for WebSockets, allowing you to build real-time applications and APIs that can maintain persistent connections with clients.
You can define WebSocket routes and handlers using a similar API to regular HTTP routes, and manage WebSocket connections and messages in a straightforward way.

```typescript
route.ws("/ws").handle(({ ws, ctx }) => {
  // This handler will be called when a client connects to the WebSocket endpoint at /ws
  ws.on("message", (message) => {
    // Handle incoming WebSocket messages from the client
    console.log("Received message:", message);
    ws.send("Hello from the server!"); // Send a message back to the client
  });
});
```

# SSE (Server-Sent Events)

`fishenv.http` also includes support for Server-Sent Events (SSE), allowing you to build real-time applications that can push updates from the server to the client over a single HTTP connection.
You can define SSE routes and handlers using a similar API to regular HTTP routes, and manage SSE connections and events in a straightforward way.

```typescript
route.sse("/sse").handle(({ sse, ctx }) => {
  // This handler will be called when a client connects to the SSE endpoint at /sse
  setInterval(() => {
    // Send an event to the client every 5 seconds
    sse.send(
      "Hello from the server! The time is " + new Date().toLocaleTimeString(),
    );
  }, 5000);
});
```

# Streaming Responses

`fishenv.http` also includes support for streaming responses, allowing you to send data to the client in chunks as it becomes available, rather than waiting for the entire response to be ready before sending it to the client.
This can be useful for scenarios such as sending large files, streaming data from a database, or implementing real-time updates without using WebSockets or SSE.
You can define a streaming route and handler that uses a readable stream to send data to the client in chunks, and manage the streaming connection in a straightforward way.

```typescript
route.stream("/stream").handle(({ res, ctx }) => {
  const stream = new ReadableStream({
    start(controller) {
      // This function will be called when the streaming response is initiated
      let count = 0;
      const interval = setInterval(() => {
        if (count < 10) {
          controller.enqueue("Chunk " + count); // Send a chunk of data to the client
          count++;
        } else {
          clearInterval(interval);
          controller.close(); // Close the stream when done
        }
      }, 1000);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain" });
});
```

# Static File Serving

`fishenv.http` also includes support for serving static files, allowing you to easily serve HTML, CSS, JavaScript, images, and other static assets from your application.
You can define a static file route that serves files from a specified directory, and configure options such as caching and directory listing.

```typescript
route.static("/static", {
  directory: "./public", // The directory from which to serve static files
  cacheControl: "max-age=3600", // Cache control header for static files
  directoryListing: false, // Whether to enable directory listing for the static file route
});
```

# Async Local Storage

`fishenv.http` also includes support for Async Local Storage, allowing you to store and access data that is specific to a particular request or context throughout the lifecycle of that request.
This can be useful for scenarios such as tracking request-specific data, managing user sessions, or implementing request-scoped dependency injection.
You can use Async Local Storage to create a context that is accessible in your route handlers and middleware, allowing you to store and retrieve data that is specific to the current request without having to pass it explicitly through function parameters.

# Open API Documentation

`fishenv.http` also includes support for generating OpenAPI documentation for your API, allowing you to easily document your endpoints, request and response schemas, and other details about your API in a standardized format.
You can define metadata for your routes, such as the title and description, and specify input and output schemas for your routes, which will be used to generate the OpenAPI documentation.

# RPC/Client Generation

`fishenv.http` also includes support for generating RPC clients based on your route definitions, allowing you to easily create clients for your API.
It should be scoped to a specific HTTP client (fishenv.wrq).

We need to build a client generator that parses the route definitions and generates client code that can be used to make requests to the API endpoints defined in `fishenv.http`.

# Project structure

- core/: Core functionality of the HTTP server, including request handling, routing, middleware, and error handling.
- ws/: WebSocket support and related functionality.
- sse/: Server-Sent Events support and related functionality.
- static/: Static file serving functionality.
- di/: Dependency injection container and related functionality.
- openapi/: OpenAPI documentation generation functionality.
- client-gen/: RPC client generation functionality.
- utils/: Utility functions and helpers used across the project.

# Footnote

Its important that we dont try to be very generic in regards to allow all forms of setups, it should be somewhat strict and opinionated to keep a clean and maintainable API.
But we should have all the features to create any type of http server/api without alot of burden on the developer. It should be easy to use, and quick to get started.

The structure of the code should be modular and organized, with clear separation of concerns between different parts of the framework (e.g., routing, middleware, error handling, etc.).
This is to ensure that the codebase remains maintainable and scalable as the framework evolves and grows over time.

We should also prioritize performance and efficiency in the design and implementation of the framework, to ensure that it can handle a large number of requests and provide a responsive experience for users.

We must use well defined TypeScript types and interfaces throughout the codebase to ensure type safety and improve developer experience when using the framework. This includes defining types for requests, responses, middleware, route handlers, and other components of the framework.
We must use established standards for HTTP and web development, such as the Fetch API for handling requests and responses, and the OpenAPI specification for documenting APIs. This will help to ensure that the framework is compatible with existing tools and libraries in the ecosystem, and that it follows best practices for web development.

We use the Deno runtime for this project, which provides a secure and modern environment for building web applications and APIs. Deno's built-in support for TypeScript, its standard library, and its focus on security and performance make it an ideal choice for this project.
We use DENO 2.7+ to take advantage of the latest features.

- https://docs.deno.com/api/deno/~/Deno.serve
- https://docs.deno.com/examples/http_server_files/
- https://docs.deno.com/examples/http_server_streaming/
- https://docs.deno.com/examples/http_server_websocket/
- https://docs.deno.com/examples/file_server_tutorial/
