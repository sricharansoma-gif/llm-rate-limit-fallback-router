export interface GatewayRequest {
  tenantApiKey: string;
  prompt: string;
  tokenCount: number;
}

export interface GatewayResponse {
  provider: string;
  output: string;
  usage: {
    totalTokens: number;
  };
}

export interface GatewayErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
