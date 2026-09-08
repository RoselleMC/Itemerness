package com.iroselle.itemerness.bukkit.api;

import com.iroselle.itemerness.api.ApiCallResult;
import com.iroselle.itemerness.api.ItemKey;
import com.iroselle.itemerness.bukkit.event.ItemernessCatalogPublishedEvent;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;
import org.bukkit.event.Cancellable;
import org.bukkit.inventory.ItemStack;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BukkitApiJavaContractsTest {
    @Test
    void oneArgumentCreateRemainsCallableFromJavaAndDelegatesAmountOne() {
        AtomicInteger requestedAmount = new AtomicInteger();
        ApiCallResult<ItemStack> expected = new ApiCallResult.Success<>(null);
        BoundBukkitItemernessApi api = (BoundBukkitItemernessApi) Proxy.newProxyInstance(
            BoundBukkitItemernessApi.class.getClassLoader(),
            new Class<?>[] {BoundBukkitItemernessApi.class},
            (proxy, method, arguments) -> {
                if (method.isDefault()) {
                    return InvocationHandler.invokeDefault(proxy, method, arguments);
                }
                if (method.getName().equals("createItem") && method.getParameterCount() == 2) {
                    requestedAmount.set((Integer) arguments[1]);
                    return expected;
                }
                throw new AssertionError("Unexpected API call: " + method);
            }
        );

        assertSame(expected, api.createItem(ItemKey.parse("example:test")));
        assertEquals(1, requestedAmount.get());
    }

    @Test
    void catalogEventExposesJavaGettersAndBukkitStaticHandlerList() throws Exception {
        ItemernessCatalogPublishedEvent event = new ItemernessCatalogPublishedEvent(42);

        assertEquals(42, event.getCatalogRevision());
        assertSame(ItemernessCatalogPublishedEvent.getHandlerList(), event.getHandlers());
        assertTrue(Modifier.isStatic(ItemernessCatalogPublishedEvent.class.getMethod("getHandlerList").getModifiers()));
        assertFalse(event.isAsynchronous());
        assertFalse(Cancellable.class.isAssignableFrom(ItemernessCatalogPublishedEvent.class));
    }

    @Test
    void catalogEventRejectsNegativeRevisionAndRetainsLongRange() {
        assertThrows(IllegalArgumentException.class, () -> new ItemernessCatalogPublishedEvent(-1));
        assertEquals(0, new ItemernessCatalogPublishedEvent(0).getCatalogRevision());
        assertEquals(Long.MAX_VALUE, new ItemernessCatalogPublishedEvent(Long.MAX_VALUE).getCatalogRevision());
    }
}
