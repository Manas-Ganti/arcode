def category_totals(csv_text):
    """Sum the `amount` column per `category`. Input is CSV text with a header row."""
    lines = csv_text.strip().split("\n")
    header = lines[0].split(",")
    ci, ai = header.index("category"), header.index("amount")
    totals = {}
    for line in lines[1:]:
        fields = line.split(",")
        totals[fields[ci]] = totals.get(fields[ci], 0) + float(fields[ai])
    return totals
