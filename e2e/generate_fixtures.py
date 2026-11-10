"""Generate synthetic, non-sensitive Parquet fixtures only during CI.

All data is deterministic and stays in the runner. No fixtures are shipped in
the standalone HTML, and no local user file is used.
"""
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

out = Path(__file__).resolve().parent / "generated-fixtures"
out.mkdir(exist_ok=True)

count = 123
columns = {
    "id": pa.array([i - 61 for i in range(count)], type=pa.int64()),
    "name": pa.array([f"item-{i:03d}" if i % 5 else f"東京-{i:03d}" for i in range(count)], type=pa.string()),
    "amount": pa.array([i / 4 - 10.5 for i in range(count)], type=pa.float64()),
    "active": pa.array([i % 2 == 0 for i in range(count)], type=pa.bool_()),
    "notes": pa.array([None if i % 7 == 0 else f"quote,\"line\n{i}\"" for i in range(count)], type=pa.string()),
    "payload": pa.array([bytes([i % 256, 0, 255]) for i in range(count)], type=pa.binary()),
    "nullable": pa.array([None if i % 11 == 0 else i * 2 for i in range(count)], type=pa.int32()),
}
table = pa.table(columns)
matrix = [
    ("NONE", "1.0", True),
    ("SNAPPY", "1.0", True),
    ("GZIP", "2.0", False),
    ("BROTLI", "1.0", True),
    ("ZSTD", "2.0", True),
    ("LZ4", "1.0", False),
]
for codec, page_version, dictionary in matrix:
    dest = out / f"{codec.lower()}.parquet"
    pq.write_table(
        table, dest, compression=codec, version="2.6",
        data_page_version=page_version, row_group_size=17, use_dictionary=dictionary,
    )
    opened = pq.ParquetFile(dest)
    assert opened.metadata.num_rows == count
    assert opened.metadata.num_row_groups == 8
    print(f"{codec}: {dest.stat().st_size} bytes, page v{page_version}, {opened.metadata.num_row_groups} groups")
