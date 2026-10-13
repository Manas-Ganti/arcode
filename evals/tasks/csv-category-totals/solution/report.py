import csv
import io


def category_totals(csv_text):
    """Sum the `amount` column per `category`. Input is CSV text with a header row."""
    totals = {}
    for row in csv.DictReader(io.StringIO(csv_text, newline="")):
        if not row.get("category") and not row.get("amount"):
            continue
        totals[row["category"]] = totals.get(row["category"], 0.0) + float(row["amount"])
    return totals
