export const RedisKeys = {
    // 1. Resource Master Catalog (Cached metadata: name, category, unit, isPerishable)
    resourceDetails: (resourceId: string) => `resource:${resourceId}:details`,

    // 2. Warehouse Inventory Stock (Hash storing: totalQuantity, reservedQuantity, availableQuantity)
    inventoryStock: (inventoryId: string) => `inventory:${inventoryId}:stock`,

    // 3. Stock per Warehouse & Resource mapping (Quick lookup without querying Mongo)
    warehouseResourceStock: (warehouseName: string, resourceId: string) =>
        `warehouse:${warehouseName}:resource:${resourceId}:stock`,

    // 4. Global Available Stock Summary (Atomic integer count per resource across all warehouses)
    resourceGlobalAvailableCount: (resourceId: string) => `resource:${resourceId}:available:count`,

    // 5. Geospatial Index for Warehouses (<longitude> <latitude> <warehouseName/inventoryId>)
    // Used by Python allocation_svc for fast spatial proximity algorithms
    warehouseLocations: () => "warehouses:locations",

    // 6. Temporary Allocation Lock Key (Prevents race conditions during multi-step reservation)
    // Value: allocationId / referenceId | TTL: e.g., 5-10 minutes
    reservationLock: (inventoryId: string) => `lock:inventory:${inventoryId}:reservation`
};