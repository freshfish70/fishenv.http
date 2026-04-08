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
  .input('json', { body: SomeSchema, headers: AnotherSchema, query: YetAnotherSchema, cookies: CookieSchema }) // <-- specify the input schema for the route, which will be used for validation and type inference (e.g., body is validated against SomeSchema, headers are validated against AnotherSchema, etc.)
  .output(SomeOutputSchema);
  .handle( // Handle is the last method in the chain, only catch can come after handle.
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
  )

/// Typesafe input variants

// Json body input with schema validation, if no schema is provided, it will be inferred as unknown
route.post("/abc").input('json', { body: SomeSchema })
route.post("/abc").input('multipart', { body: SomeSchema })
route.post("/abc").input('urlencoded', { body: SomeSchema })
route.post("/abc").handle() // If input is omitted it will be inferred as unknown, so body would be unknown in this case.

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
route.get("/stream").handle(({ res, ctx }) => {
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

#
