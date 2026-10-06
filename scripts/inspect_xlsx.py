from __future__ import annotations

import json
import hashlib
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": REL_NS}


def column_index(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref or "")
    if not letters:
        return 0
    result = 0
    for char in letters.group(0):
        result = result * 26 + ord(char) - 64
    return result


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []

    values = []
    for item in root.findall(f"{{{MAIN_NS}}}si"):
        parts = [node.text or "" for node in item.iter(f"{{{MAIN_NS}}}t")]
        values.append("".join(parts))
    return values


def workbook_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        item.attrib["Id"]: item.attrib["Target"]
        for item in rels.findall(f"{{{PKG_REL_NS}}}Relationship")
    }

    sheets = []
    for sheet in workbook.findall("m:sheets/m:sheet", NS):
        rel_id = sheet.attrib[f"{{{REL_NS}}}id"]
        target = targets[rel_id].replace("\\", "/")
        if target.startswith("/"):
            path = target.lstrip("/")
        elif target.startswith("xl/"):
            path = target
        else:
            path = f"xl/{target}"
        sheets.append((sheet.attrib["name"], path))
    return sheets


def cell_value(cell: ET.Element, strings: list[str]) -> object:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{{{MAIN_NS}}}t"))

    value_node = cell.find(f"{{{MAIN_NS}}}v")
    if value_node is None or value_node.text is None:
        formula = cell.find(f"{{{MAIN_NS}}}f")
        return f"={formula.text}" if formula is not None and formula.text else ""

    raw = value_node.text
    if cell_type == "s":
        index = int(raw)
        return strings[index] if 0 <= index < len(strings) else raw
    if cell_type == "b":
        return raw == "1"
    if cell_type in {"str", "e"}:
        return raw

    try:
        number = float(raw)
        return int(number) if number.is_integer() else number
    except ValueError:
        return raw


def inspect_sheet(
    archive: zipfile.ZipFile,
    path: str,
    strings: list[str],
    max_rows: int,
    max_cols: int,
) -> dict[str, object]:
    root = ET.fromstring(archive.read(path))
    dimension_node = root.find("m:dimension", NS)
    dimension = dimension_node.attrib.get("ref") if dimension_node is not None else None
    rows = root.findall("m:sheetData/m:row", NS)
    non_empty_rows = []
    max_seen_col = 0

    for row in rows[:max_rows]:
        values: dict[int, object] = {}
        for cell in row.findall("m:c", NS):
            col = column_index(cell.attrib.get("r", ""))
            if not col or col > max_cols:
                continue
            value = cell_value(cell, strings)
            if value not in {"", None}:
                if isinstance(value, str) and len(value) > 120:
                    value = value[:117] + "..."
                values[col] = value
                max_seen_col = max(max_seen_col, col)

        if values:
            last_col = max(values)
            non_empty_rows.append(
                {
                    "row": int(row.attrib.get("r", len(non_empty_rows) + 1)),
                    "values": [values.get(index, "") for index in range(1, last_col + 1)],
                }
            )

    return {
        "dimension": dimension,
        "xml_row_count": len(rows),
        "max_seen_col_in_sample": max_seen_col,
        "sample_rows": non_empty_rows,
    }


def inspect_workbook(path: Path, max_rows: int = 24, max_cols: int = 60) -> dict[str, object]:
    with zipfile.ZipFile(path) as archive:
        strings = shared_strings(archive)
        sheet_info = []
        for name, sheet_path in workbook_sheets(archive):
            info = inspect_sheet(archive, sheet_path, strings, max_rows, max_cols)
            info["name"] = name
            sheet_info.append(info)

    return {"file": path.name, "size": path.stat().st_size, "sheets": sheet_info}


def signature_for_workbook(path: Path) -> dict[str, object]:
    workbook = inspect_workbook(path, max_rows=3, max_cols=1000)
    sheet_summaries = []
    for sheet in workbook["sheets"]:
        rows = sheet["sample_rows"]
        headers = rows[0]["values"] if rows else []
        first_record = rows[1]["values"] if len(rows) > 1 else []
        digest = hashlib.sha256(
            json.dumps(headers, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        duplicate_headers = sorted(
            value
            for value, count in Counter(str(value) for value in headers if value != "").items()
            if count > 1
        )
        sheet_summaries.append(
            {
                "name": sheet["name"],
                "dimension": sheet["dimension"],
                "row_count": sheet["xml_row_count"],
                "field_count": len(headers),
                "header_sha256": digest,
                "headers": headers,
                "first_record_prefix": first_record[:6],
                "duplicate_headers": duplicate_headers,
                "blank_header_count": sum(1 for value in headers if value == ""),
            }
        )
    return {"file": path.name, "sheets": sheet_summaries}


def date_range_from_name(name: str) -> tuple[str | None, str | None]:
    match = re.search(r"(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})", name)
    return match.groups() if match else (None, None)


def summarize_group(directory: Path) -> dict[str, object]:
    files = sorted(directory.glob("*.xlsx"))
    signatures = [signature_for_workbook(path) for path in files]
    all_sheets = [sheet for workbook in signatures for sheet in workbook["sheets"]]
    header_counts = Counter(sheet["header_sha256"] for sheet in all_sheets)
    dimension_counts = Counter(str(sheet["dimension"]) for sheet in all_sheets)
    sheet_name_counts = Counter(str(sheet["name"]) for sheet in all_sheets)
    row_counts = [int(sheet["row_count"]) for sheet in all_sheets]
    field_counts = [int(sheet["field_count"]) for sheet in all_sheets]
    first_start, first_end = date_range_from_name(files[0].name) if files else (None, None)
    last_start, last_end = date_range_from_name(files[-1].name) if files else (None, None)
    representative = all_sheets[0] if all_sheets else None
    last_representative = signatures[-1]["sheets"][0] if signatures else None
    representative_headers = representative["headers"] if representative else []
    records: list[list[object]] = []
    date_range_mismatches = []
    latest_period_mismatches = []

    for path in files:
        workbook = inspect_workbook(path, max_rows=1000, max_cols=1000)
        rows = workbook["sheets"][0]["sample_rows"] if workbook["sheets"] else []
        data_rows = [row["values"] for row in rows[1:]]
        records.extend(data_rows)
        expected_start, expected_end = date_range_from_name(path.name)
        expected_range = f"{expected_start}|{expected_end}"
        range_index = 4 if directory.name == "overview-daily" else 1

        for values in data_rows:
            actual_range = values[range_index] if len(values) > range_index else None
            if actual_range != expected_range:
                date_range_mismatches.append(
                    {"file": path.name, "expected": expected_range, "actual": actual_range}
                )

        if directory.name == "dashboard-monthly" and data_rows:
            latest_statistic_date = data_rows[-1][0] if data_rows[-1] else None
            if latest_statistic_date != expected_end:
                latest_period_mismatches.append(
                    {"file": path.name, "expected": expected_end, "actual": latest_statistic_date}
                )

    completeness = []
    for index, header in enumerate(representative_headers):
        present = sum(
            1
            for values in records
            if len(values) > index and values[index] not in {"", None}
        )
        completeness.append(
            {
                "column": index + 1,
                "header": header,
                "present": present,
                "total": len(records),
                "rate": round(present / len(records), 6) if records else 0,
            }
        )

    statistic_date_index = 4 if directory.name == "overview-daily" else 0
    statistic_dates = []
    for values in records:
        if len(values) <= statistic_date_index or values[statistic_date_index] in {"", None}:
            continue
        value = str(values[statistic_date_index])
        statistic_dates.append(value.split("|", 1)[0])

    duplicate_header_comparisons = []
    for header in representative["duplicate_headers"] if representative else []:
        indexes = [index for index, value in enumerate(representative_headers) if value == header]
        all_equal = 0
        differing = 0
        for values in records:
            compared = [values[index] if len(values) > index else "" for index in indexes]
            if len(set(str(value) for value in compared)) <= 1:
                all_equal += 1
            else:
                differing += 1
        duplicate_header_comparisons.append(
            {
                "header": header,
                "columns": [index + 1 for index in indexes],
                "all_equal_records": all_equal,
                "differing_records": differing,
            }
        )
    lowest_completeness = sorted(
        (item for item in completeness if item["rate"] < 1),
        key=lambda item: (item["rate"], item["column"]),
    )[:25]

    return {
        "directory": directory.name,
        "file_count": len(files),
        "first_file": files[0].name if files else None,
        "last_file": files[-1].name if files else None,
        "filename_date_span": {
            "start": first_start,
            "first_end": first_end,
            "last_start": last_start,
            "end": last_end,
        },
        "sheet_name_counts": dict(sheet_name_counts),
        "dimension_counts": dict(dimension_counts),
        "row_count_range": [min(row_counts), max(row_counts)] if row_counts else [0, 0],
        "field_count_range": [min(field_counts), max(field_counts)] if field_counts else [0, 0],
        "distinct_header_signatures": len(header_counts),
        "header_signature_counts": dict(header_counts),
        "representative_headers": representative_headers,
        "representative_first_record_prefix": (
            representative["first_record_prefix"] if representative else []
        ),
        "last_record_prefix": (
            last_representative["first_record_prefix"] if last_representative else []
        ),
        "duplicate_headers": representative["duplicate_headers"] if representative else [],
        "duplicate_header_comparisons": duplicate_header_comparisons,
        "blank_header_count": representative["blank_header_count"] if representative else 0,
        "record_count_in_workbooks": len(records),
        "unique_statistic_dates": len(set(statistic_dates)),
        "statistic_date_span": {
            "start": min(statistic_dates) if statistic_dates else None,
            "end": max(statistic_dates) if statistic_dates else None,
        },
        "date_range_mismatch_count": len(date_range_mismatches),
        "date_range_mismatch_samples": date_range_mismatches[:5],
        "latest_period_mismatch_count": len(latest_period_mismatches),
        "latest_period_mismatch_samples": latest_period_mismatches[:5],
        "completeness_summary": {
            "complete_fields": sum(1 for item in completeness if item["rate"] == 1),
            "partially_missing_fields": sum(1 for item in completeness if 0 < item["rate"] < 1),
            "always_blank_fields": sum(1 for item in completeness if item["rate"] == 0),
        },
        "lowest_completeness_fields": lowest_completeness,
    }


def sample_files(directory: Path) -> list[Path]:
    files = sorted(directory.glob("*.xlsx"))
    if not files:
        return []
    indexes = sorted({0, len(files) // 2, len(files) - 1})
    return [files[index] for index in indexes]


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "audit/homepage-unpacked")
    summary_mode = "--summary" in sys.argv
    groups = {}
    for directory in sorted(path for path in root.iterdir() if path.is_dir()):
        if summary_mode:
            groups[directory.name] = summarize_group(directory)
            continue
        files = sorted(directory.glob("*.xlsx"))
        groups[directory.name] = {
            "file_count": len(files),
            "first_file": files[0].name if files else None,
            "last_file": files[-1].name if files else None,
            "samples": [inspect_workbook(path) for path in sample_files(directory)],
        }
    payload = json.dumps(groups, ensure_ascii=False, indent=2)
    output_arg = next((arg for arg in sys.argv if arg.startswith("--output=")), None)
    if output_arg:
        output_path = Path(output_arg.split("=", 1)[1])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload, encoding="utf-8")
        print(str(output_path))
    else:
        print(json.dumps(groups, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
