import fetchMock from "fetch-mock";
import type { CallHistoryFilter, CallLog, RouteResponse, UserRouteConfig } from "fetch-mock";

export const namsBaseUrl = "https://memory.example.test";

type RequestFilter = CallHistoryFilter;
type RequestOptions = UserRouteConfig;
type ParsedRequestBody = Record<string, any>;
type FetchMockCall = Pick<CallLog, "options">;
interface ParsedRequestBodies extends Array<ParsedRequestBody> {
  at(index: number): ParsedRequestBody;
}

export interface NamsFetchMock {
  calls(filter?: RequestFilter, options?: RequestOptions): CallLog[];
  requestBodies(filter?: RequestFilter, options?: RequestOptions): ParsedRequestBodies;
  requestBody(callOrFilter?: FetchMockCall | RequestFilter, options?: RequestOptions): ParsedRequestBody;
  fetch: typeof fetch;
  createConversation(response?: RouteResponse, status?: number): NamsFetchMock;
  context(response?: RouteResponse, status?: number, conversationId?: string): NamsFetchMock;
  message(response?: RouteResponse, status?: number, conversationId?: string): NamsFetchMock;
  workspaces(response?: RouteResponse, status?: number): NamsFetchMock;
  searchEntities(response?: RouteResponse, status?: number): NamsFetchMock;
  reasoningStep(response?: RouteResponse, status?: number): NamsFetchMock;
  toolCall(response?: RouteResponse, status?: number): NamsFetchMock;
  get(pathname: string, response: RouteResponse, status?: number, name?: string): NamsFetchMock;
  post(pathname: string, response: RouteResponse, status?: number, name?: string): NamsFetchMock;
  route(method: string, pathname: string, response: RouteResponse, status?: number, name?: string): NamsFetchMock;
  all(response: RouteResponse, status?: number): NamsFetchMock;
  throws(error: Error): NamsFetchMock;
}

export function createNamsFetchMock(baseUrl = namsBaseUrl): NamsFetchMock {
  const mock = fetchMock.createInstance();
  const fetchHandler: typeof fetch = mock.fetchHandler.bind(mock);
  globalThis.fetch = fetchHandler;

  const api: NamsFetchMock = {
    calls: (filter, options) => mock.callHistory.calls(filter, options),
    requestBodies: (filter, options) =>
      api.calls(filter, options).map((call) => api.requestBody(call)) as ParsedRequestBodies,
    requestBody(callOrFilter, options) {
      const call =
        typeof callOrFilter === "object" && callOrFilter !== null && "options" in callOrFilter
          ? callOrFilter
          : mock.callHistory.lastCall(callOrFilter, options);
      if (!call?.options.body) {
        return undefined as unknown as ParsedRequestBody;
      }
      return JSON.parse(String(call.options.body)) as ParsedRequestBody;
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
    workspaces(response = { workspaces: [] }, status = 200) {
      return api.get("/v1/users/me/workspaces", response, status, "listMyWorkspaces");
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
      mock.route({
        url: `${baseUrl}${pathname}`,
        method,
        name,
        response: typeof response === "function" ? response : { status, body: response },
      });
      return api;
    },
    all(response, status = 200) {
      mock.route({ url: { begin: baseUrl }, name: "fallback", response: { status, body: response } });
      return api;
    },
    throws(error) {
      mock.route({ url: { begin: baseUrl }, name: "fallback", response: { throws: error } });
      return api;
    },
  };

  return api;
}
