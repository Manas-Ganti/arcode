from dataclasses import dataclass


def normalize_sku(sku: str) -> str:
    return sku.strip().upper()


@dataclass
class Reservation:
    order_id: str
    sku: str
    qty: int
