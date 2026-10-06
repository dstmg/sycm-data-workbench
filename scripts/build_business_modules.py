from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from inspect_xlsx import MAIN_NS, NS, cell_value, column_index, shared_strings, workbook_sheets


ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = ROOT / "raw"
NORMALIZED_ROOT = ROOT / "normalized"
MODULES = {
    "transaction": "02-交易",
    "traffic": "03-流量",
    "customer": "04-客户",
}


def write_json(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(path)


def recover_zip_name(name: str) -> str:
    try:
        return name.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def source_fingerprint(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        stat = path.stat()
        digest.update(path.name.encode("utf-8"))
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
    return digest.hexdigest()


def read_rows(workbook_bytes: bytes) -> list[tuple[str, str | None, list[list[object]]]]:
    sheets_out = []
    with zipfile.ZipFile(io.BytesIO(workbook_bytes)) as archive:
        strings = shared_strings(archive)
        for sheet_name, sheet_path in workbook_sheets(archive):
            root = ET.fromstring(archive.read(sheet_path))
            dimension = root.find("m:dimension", NS)
            rows = []
            for row in root.findall("m:sheetData/m:row", NS):
                values = {}
                for cell in row.findall(f"{{{MAIN_NS}}}c"):
                    column = column_index(cell.attrib.get("r", ""))
                    if column:
                        values[column] = cell_value(cell, strings)
                rows.append([values.get(index, "") for index in range(1, max(values, default=0) + 1)])
            sheets_out.append(
                (sheet_name, dimension.attrib.get("ref") if dimension is not None else None, rows)
            )
    return sheets_out


def normalize_cell(value: object) -> object:
    return None if value in {"", "-", "--"} else value


def header_layout(rows: list[list[object]]) -> tuple[list[str], list[str | None], int]:
    if not rows:
        return [], [], 0
    first = [str(value).strip() for value in rows[0]]
    if "栏目" in first:
        return first, [None] * len(first), 1
    if len(rows) > 1:
        second = [str(value).strip() for value in rows[1]]
        if "栏目" in second:
            width = max(len(first), len(second))
            first += [""] * (width - len(first))
            second += [""] * (width - len(second))
            groups = []
            current = None
            for value in first:
                if value:
                    current = value
                groups.append(current)
            return second, groups, 2
    return first, [None] * len(first), 1


def schema_for(headers: list[str], groups: list[str | None]) -> list[dict]:
    duplicates = Counter(header for header in headers if header)
    schema = []
    for index, header in enumerate(headers):
        header = header or f"未命名列{index + 1}"
        group = groups[index] if index < len(groups) else None
        display_name = f"{group} / {header}" if group and group != "任务信息" else header
        if duplicates[header] > 1:
            display_name = f"{display_name}（位置{index + 1}）"
        schema.append(
            {
                "id": f"col_{index + 1:03d}",
                "column": index + 1,
                "header": header,
                "group": group,
                "display_name": display_name,
                "duplicate_header": duplicates[header] > 1,
            }
        )
    return schema


def find_index(schema: list[dict], header: str) -> int | None:
    return next((index for index, item in enumerate(schema) if item["header"] == header), None)


def value_at(values: list[object], index: int | None) -> object:
    return values[index] if index is not None and index < len(values) else None


def filename_dates(name: str) -> list[str]:
    return re.findall(r"20\d{2}-\d{2}-\d{2}", name)


def scan_module(module_key: str, folder: str) -> dict:
    archive_paths = sorted((RAW_ROOT / folder).glob("*.zip"))
    datasets: dict[str, dict] = {}
    sources = []
    workbook_total = 0

    for archive_path in archive_paths:
        archive_workbooks = 0
        with zipfile.ZipFile(archive_path) as outer:
            for member in outer.infolist():
                if member.is_dir() or not member.filename.lower().endswith(".xlsx"):
                    continue
                archive_workbooks += 1
                workbook_total += 1
                workbook_name = recover_zip_name(member.filename)
                for sheet_name, dimension, rows in read_rows(outer.read(member)):
                    headers, groups, data_start = header_layout(rows)
                    if not headers:
                        continue
                    schema = schema_for(headers, groups)
                    signature = hashlib.sha256(
                        json.dumps(
                            [(item["header"], item["group"]) for item in schema],
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ).encode("utf-8")
                    ).hexdigest()
                    dataset_id = hashlib.sha256(
                        f"{archive_path.name}|{sheet_name}|{signature}".encode("utf-8")
                    ).hexdigest()[:16]
                    dataset = datasets.setdefault(
                        dataset_id,
                        {
                            "id": dataset_id,
                            "archive_file": archive_path.name,
                            "sheet": sheet_name,
                            "header_signature": signature,
                            "schema": schema,
                            "records": [],
                            "dimensions": Counter(),
                            "workbook_count": 0,
                            "workbooks": set(),
                        },
                    )
                    dataset["dimensions"][str(dimension)] += 1
                    dataset["workbooks"].add(workbook_name)
                    dataset["workbook_count"] = len(dataset["workbooks"])

                    indexes = {
                        key: find_index(schema, header)
                        for key, header in {
                            "date_range": "日期范围",
                            "statistic_date": "统计日期",
                            "date": "日期",
                            "dimension": "维度",
                            "data_point": "数据点",
                            "shop_id": "店铺 ID",
                            "export_time": "导出时间",
                        }.items()
                    }
                    for row_number, row in enumerate(rows[data_start:], start=data_start + 1):
                        values = [normalize_cell(row[index] if index < len(row) else None) for index in range(len(schema))]
                        if not any(value is not None for value in values):
                            continue
                        dates = filename_dates(workbook_name)
                        dataset["records"].append(
                            {
                                "workbook_file": workbook_name,
                                "row": row_number,
                                "date_range": value_at(values, indexes["date_range"]),
                                "statistic_date": value_at(values, indexes["statistic_date"])
                                or value_at(values, indexes["date"])
                                or (dates[0] if len(dates) == 1 else None),
                                "dimension": value_at(values, indexes["dimension"]),
                                "data_point": value_at(values, indexes["data_point"]),
                                "shop_id": value_at(values, indexes["shop_id"]),
                                "export_time": value_at(values, indexes["export_time"]),
                                "values": values,
                            }
                        )
        sources.append(
            {
                "name": archive_path.name,
                "size": archive_path.stat().st_size,
                "modified_at": datetime.fromtimestamp(archive_path.stat().st_mtime, timezone.utc).isoformat(),
                "workbook_count": archive_workbooks,
            }
        )

    dataset_list = []
    all_dates = []
    for dataset in datasets.values():
        records = dataset["records"]
        schema = dataset["schema"]
        for record in records:
            if record["statistic_date"]:
                all_dates.append(str(record["statistic_date"]).split("|", 1)[0])
            if record["date_range"]:
                all_dates.extend(str(record["date_range"]).split("|", 1))
        completeness = []
        for index, field in enumerate(schema):
            present = sum(1 for record in records if record["values"][index] is not None)
            completeness.append(
                {
                    "id": field["id"],
                    "present": present,
                    "total": len(records),
                    "rate": round(present / len(records), 6) if records else 0,
                }
            )
        dataset["dimensions"] = dict(dataset["dimensions"])
        dataset["workbooks"] = sorted(dataset["workbooks"])
        dataset["completeness"] = completeness
        dataset_list.append(dataset)

    valid_dates = sorted(value for value in all_dates if re.fullmatch(r"20\d{2}-\d{2}-\d{2}", value))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "module": module_key,
        "folder": folder,
        "source_fingerprint": source_fingerprint(archive_paths),
        "sources": sources,
        "quality": {
            "archive_count": len(archive_paths),
            "workbook_count": workbook_total,
            "dataset_count": len(dataset_list),
            "record_count": sum(len(dataset["records"]) for dataset in dataset_list),
            "date_start": valid_dates[0] if valid_dates else None,
            "date_end": valid_dates[-1] if valid_dates else None,
            "shop_ids": sorted(
                {
                    str(record["shop_id"])
                    for dataset in dataset_list
                    for record in dataset["records"]
                    if record["shop_id"] is not None
                }
            ),
        },
        "datasets": sorted(dataset_list, key=lambda item: (item["archive_file"], item["sheet"], item["id"])),
    }


def main() -> None:
    NORMALIZED_ROOT.mkdir(parents=True, exist_ok=True)
    result = {}
    for module_key, folder in MODULES.items():
        payload = scan_module(module_key, folder)
        output = NORMALIZED_ROOT / f"{module_key}-data.json"
        write_json(output, payload)
        result[module_key] = {"output": str(output), **payload["quality"]}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
