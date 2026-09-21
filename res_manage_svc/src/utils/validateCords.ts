/**
 * Validates whether an input is a valid GeoJSON [longitude, latitude] coordinate pair.
 */
export const isValidCoordinates = (coords: any): coords is [number, number] => {
    if (!Array.isArray(coords) || coords.length !== 2) {
        return false;
    }

    const [lng, lat] = coords;

    // Check if both elements are numbers and not NaN/Infinity
    if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) {
        return false;
    }

    // Validate geographic coordinate boundaries
    const isValidLongitude = lng >= -180 && lng <= 180;
    const isValidLatitude = lat >= -90 && lat <= 90;

    return isValidLongitude && isValidLatitude;
};