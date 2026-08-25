export {
  getKernel,
  kernelSupports,
  resetKernelForTests,
  type KernelBuffers,
  type KernelContractInfo,
  type KernelModule,
} from "./loader.js";
export { decodeExtractBuffers } from "./decode.js";
export {
  NODE_KINDS,
  EDGE_KINDS,
  type Node,
  type Edge,
  type NodeKind,
  type EdgeKind,
  type ReferenceKind,
  type UnresolvedReference,
  type ExtractionResult,
  type ExtractionError,
} from "./types.js";
