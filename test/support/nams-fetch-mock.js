import fetchMock from "fetch-mock";

export const namsBaseUrl = "https://memory.example.test";

export function createNamsFetchMock(baseUrl = namsBaseUrl) {
  const mock = fetchMock.createInstance();
  const requests = [];

  const api = {
    requests,
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return mock.fetchHandler(url, init);
    },
    createConversation(response = { id: "conversation-1" }, status = 201) {
      return api.post("/v1/conversations", response, status);
    },
    context(response = {}, status = 200, conversationId = "conversation-1") {
      return api.get(`/v1/conversations/${conversationId}/context`, response, status);
    },
    message(response = { id: "message-1" }, status = 201, conversationId = "conversation-1") {
      return api.post(`/v1/conversations/${conversationId}/messages`, response, status);
    },
    searchEntities(response = {}, status = 200) {
      return api.post("/v1/entities/search", response, status);
    },
    reasoningStep(response = { id: "step-1" }, status = 201) {
      return api.post("/v1/reasoning/steps", response, status);
    },
    toolCall(response = { id: "tool-call-1" }, status = 201) {
      return api.post("/v1/reasoning/tool-calls", response, status);
    },
    get(pathname, response, status = 200) {
      return api.route("GET", pathname, response, status);
    },
    post(pathname, response, status = 200) {
      return api.route("POST", pathname, response, status);
    },
    route(method, pathname, response, status = 200) {
      mock.route(
        { url: `${baseUrl}${pathname}`, method },
        typeof response === "function" ? response : { status, body: response },
      );
      return api;
    },
    all(response, status = 200) {
      mock.route(`begin:${baseUrl}`, { status, body: response });
      return api;
    },
    throws(error) {
      mock.route(`begin:${baseUrl}`, { throws: error });
      return api;
    },
  };

  return api;
}
