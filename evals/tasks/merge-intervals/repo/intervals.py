def merge_intervals(intervals):
    """Merge overlapping intervals. Each interval is [start, end] with start <= end."""
    merged = []
    for start, end in intervals:
        if merged and start < merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
