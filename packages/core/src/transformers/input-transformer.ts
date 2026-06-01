import type { InputEnvelope, InputMetadata } from "../types";
import type { ModelCapabilities } from "../modules/provider";

/**
 * 输入转换器接口。
 */
export interface InputTransformer {
  canHandle(metadata: InputMetadata, modelCapabilities: ModelCapabilities): boolean;
  transform(envelope: InputEnvelope): Promise<InputEnvelope>;
}

