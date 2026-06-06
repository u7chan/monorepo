import argparse
import json
import os

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    EasyOcrOptions,
    PdfPipelineOptions,
    TableFormerMode,
)
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.transforms.chunker import HierarchicalChunker


def document_to_markdown(file_path: str) -> str:
    converter = DocumentConverter()
    result = converter.convert(file_path)
    return result.document.export_to_markdown()


def document_to_markdown_with_ocr(file_path: str) -> str:
    ocr_options = EasyOcrOptions(lang=["ja"])
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = True
    pipeline_options.do_table_structure = True
    pipeline_options.table_structure_options.do_cell_matching = True
    pipeline_options.table_structure_options.mode = TableFormerMode.ACCURATE
    pipeline_options.ocr_options = ocr_options
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pipeline_options,
            ),
        }
    )
    result = converter.convert(file_path)
    return result.document.export_to_markdown()


def document_to_chunking_json(file_path: str) -> str:
    converter = DocumentConverter()
    result = converter.convert(file_path)
    doc = result.document
    doc_chunks = list(HierarchicalChunker().chunk(doc))
    text_chunks = [chunk.text for chunk in doc_chunks]
    return json.dumps(
        text_chunks,
        ensure_ascii=False,
        indent=4,
        sort_keys=True,
        separators=(",", ": "),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=str, required=True)
    args = parser.parse_args()
    file_path = args.file

    md = document_to_markdown(file_path)
    export_dir = "dist"
    export_file = f"{export_dir}/export.md"
    os.makedirs(export_dir, exist_ok=True)
    with open(export_file, "w", encoding="utf-8") as f:
        f.write(md)


if __name__ == "__main__":
    main()
