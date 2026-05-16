import fetchMock from "fetch-mock";

export const namsBaseUrl = "https://memory.example.test";

export function createNamsFetchMock(baseUrl = namsBaseUrl) {
  const mock = fetchMock.createInstance();
  const fetchHandler = mock.fetchHandler.bind(mock);
  globalThis.fetch = fetchHandler;

  const api = {
    calls: (filter, options) => mock.callHistory.calls(filter, options),
    requestBodies: (filter, options) => api.calls(filter, options).map((call) => api.requestBody(call)),
    requestBody(callOrFilter, options) {
      const call =
        typeof callOrFilter === "object" && callOrFilter !== null && "options" in callOrFilter
          ? callOrFilter
          : mock.callHistory.lastCall(callOrFilter, options);
      if (!call?.options.body) {
        return undefined;
      }
      return JSON.parse(call.options.body);
    },
    fetch: fetchHandler,
    createConversation(response = { id: "conversation-1" }, status = 201) {
      return api.post("/v1/conversations", response, status, "createConversation");
    },
    context(response = {}, status = 200, conversationId = "conversation-1") {
      return api.get(`/v1/conversations/${conversationId}/context`, response, status, "getConversationContext");
    },
    message(response = { id: "message-1" }, status = 201, conversationId = "conversation-1") {
      return api.post(`/v1/conversations/${conversationId}/messages`, response, status, "addMessage");
    },
    searchEntities(response = {}, status = 200) {
      return api.post("/v1/entities/search", response, status, "searchEntities");
    },
    reasoningStep(response = { id: "step-1" }, status = 201) {
      return api.post("/v1/reasoning/steps", response, status, "addReasoningStep");
    },
    toolCall(response = { id: "tool-call-1" }, status = 201) {
      return api.post("/v1/reasoning/tool-calls", response, status, "addToolCall");
    },
    get(pathname, response, status = 200, name = undefined) {
      return api.route("GET", pathname, response, status, name);
    },
    post(pathname, response, status = 200, name = undefined) {
      return api.route("POST", pathname, response, status, name);
    },
    route(method, pathname, response, status = 200, name = undefined) {
      mock.route(
        { url: `${baseUrl}${pathname}`, method, name },
        typeof response === "function" ? response : { status, body: response },
      );
      return api;
    },
    all(response, status = 200) {
      mock.route({ url: `begin:${baseUrl}`, name: "fallback" }, { status, body: response });
      return api;
    },
    throws(error) {
      mock.route({ url: `begin:${baseUrl}`, name: "fallback" }, { throws: error });
      return api;
    },
  };

  return api;
}
