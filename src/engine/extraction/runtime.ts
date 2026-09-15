import type { FileGraphResult } from "../graph/types.js";
import type { Content, EntityFragment } from "../types.js";
import { CodeExtractor } from "./code/extractor.js";
import { ImageExtractor } from "./image/extractor.js";
import { MarkdownExtractor } from "./markdown/extractor.js";
import type { Source } from "./source.js";
import { TextExtractor } from "./text/extractor.js";
import type { ChunkOptions } from "./types.js";

type ExtractorRoute = "code" | "image" | "markdown" | "text";

type SourceExtractor = {
  extract(source: Source, options?: ChunkOptions): Promise<EntityFragment[]>;
};

const extractors = {
  code: new CodeExtractor(),
  image: new ImageExtractor(),
  markdown: new MarkdownExtractor(),
  text: new TextExtractor(),
} satisfies Record<ExtractorRoute, SourceExtractor>;

export function extract(
  source: Source,
  options: ChunkOptions = {},
): Promise<EntityFragment[]> {
  return extractors[routeSource(source)].extract(source, options);
}

export type IndexingExtractionFragment = {
  fragment: EntityFragment;
  embeddingSource?: Content;
};

export type IndexingExtractionResult = {
  fragments: IndexingExtractionFragment[];
  graph?: FileGraphResult;
};

export async function extractForIndexing(
  source: Source,
  options: ChunkOptions = {},
): Promise<IndexingExtractionResult> {
  if (routeSource(source) === "code") {
    const result = await extractors.code.extractForIndexing(source, options);
    return {
      fragments: result.fragments.map(({ fragment, embeddingText }) => ({
        fragment,
        ...(embeddingText === undefined
          ? {}
          : { embeddingSource: { kind: "text", text: embeddingText } }),
      })),
      graph: result.graph,
    };
  }

  const fragments = (await extractors[routeSource(source)].extract(
    source,
    options,
  )).map((fragment) => ({ fragment }));

  return { fragments };
}

function routeSource(source: Source): ExtractorRoute {
  if (source.kind === "image") {
    return "image";
  }

  if (source.file.kind === "code") {
    return "code";
  }

  if (source.file.format === "markdown") {
    return "markdown";
  }

  return "text";
}
