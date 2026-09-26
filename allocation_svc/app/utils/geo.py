import math

def haversine_distance(coord1: list[float], coord2: list[float]) -> float:
    """
    Calculates distance in km between two [longitude, latitude] coordinates.
    """
    lng1, lat1 = coord1
    lng2, lat2 = coord2

    R = 6371.0  # Earth's radius in kilometers

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)

    a = (math.sin(dphi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))

    return round(R * c, 2)