def low_stock(inventory, skus, threshold):
    """SKUs whose available units are below `threshold`, in the given order."""
    return [s for s in skus if inventory.available(s) < threshold]
