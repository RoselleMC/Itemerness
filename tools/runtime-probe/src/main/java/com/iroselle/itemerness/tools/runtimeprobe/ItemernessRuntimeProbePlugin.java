package com.iroselle.itemerness.tools.runtimeprobe;

import com.iroselle.itemerness.api.ApiCallResult;
import com.iroselle.itemerness.api.ApiDenialReason;
import com.iroselle.itemerness.api.DataKey;
import com.iroselle.itemerness.api.IntegerDataValue;
import com.iroselle.itemerness.api.ItemDataMutation;
import com.iroselle.itemerness.api.ItemDataValue;
import com.iroselle.itemerness.api.ItemDefinition;
import com.iroselle.itemerness.api.ItemKey;
import com.iroselle.itemerness.api.LongDataValue;
import com.iroselle.itemerness.bukkit.api.BoundBukkitItemernessApi;
import com.iroselle.itemerness.bukkit.api.BukkitItemIdentity;
import com.iroselle.itemerness.bukkit.api.BukkitItemernessApi;
import com.iroselle.itemerness.bukkit.api.BukkitPlayerSlot;
import com.iroselle.itemerness.bukkit.api.BukkitSlotEditReceipt;
import io.papermc.paper.threadedregions.scheduler.EntityScheduler;
import io.papermc.paper.threadedregions.scheduler.ScheduledTask;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collection;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;

/** Disposable black-box probe for Itemerness's public Bukkit service contract. */
public final class ItemernessRuntimeProbePlugin extends JavaPlugin {
    private static final String PASS = "ITEMERNESS_RUNTIME_PROBE_PASS";
    private static final String FAIL = "ITEMERNESS_RUNTIME_PROBE_FAIL";
    private static final ItemKey ITEM = ItemKey.parse("itemerness:travel-token");
    private static final DataKey CHARGES = DataKey.parse("example:charges");
    private static final DataKey INTERNAL_METADATA = DataKey.parse("example:metadata");
    private static final DataKey CREATED_AT = DataKey.parse("itemerness:created-at");

    private final AtomicBoolean reported = new AtomicBoolean();

    @Override
    public void onEnable() {
        try {
            getServer().getGlobalRegionScheduler().execute(this, this::executeProbe);
        } catch (Throwable failure) {
            reportFailure("global scheduling", failure);
        }
    }

    private void executeProbe() {
        try {
            ProbeReport report = runProbe();
            if (reported.compareAndSet(false, true)) {
                getLogger().info(PASS
                    + " catalogRevision=" + report.catalogRevision()
                    + " item=" + ITEM
                    + " asyncSlotRevision=" + report.asyncSlotRevision());
            }
        } catch (Throwable failure) {
            reportFailure("contract", failure);
        }
    }

    private ProbeReport runProbe() throws Exception {
        BukkitItemernessApi service = Objects.requireNonNull(
            getServer().getServicesManager().load(BukkitItemernessApi.class),
            "BukkitItemernessApi service is not registered"
        );

        Plugin itemerness = Objects.requireNonNull(
            getServer().getPluginManager().getPlugin("Itemerness"),
            "Itemerness plugin is not registered"
        );
        expectDenied(
            service.forPlugin(itemerness),
            ApiDenialReason.CALLER_NOT_ACTIVE,
            "borrowed Itemerness plugin binding"
        );

        BoundBukkitItemernessApi api = requireSuccess(service.forPlugin(this), "bind probe plugin");
        requireCondition(getName().equals(api.getCallerPluginName()), "bound caller name changed");
        requireCondition(api.getCatalogRevision() > 0, "catalog revision is not active");

        List<ItemDefinition> items = requireSuccess(api.items(), "list catalog items");
        requireCondition(
            items.stream().map(ItemDefinition::getKey).anyMatch(ITEM::equals),
            "runtime fixture item is not visible"
        );

        ItemStack created = requireSuccess(api.createItem(ITEM, 1), "create canonical item");
        BukkitItemIdentity identity = Objects.requireNonNull(
            requireSuccess(api.identifyItem(created), "identify canonical item"),
            "created item was reported as unmanaged"
        );
        requireCondition(ITEM.equals(identity.getItemKey()), "identified item key changed");
        requireCondition(identity.getAmount() == 1, "identified item amount changed");

        requireInteger(api.readItemData(created, CHARGES), 3, "read initial charges");
        expectDenied(
            api.readItemData(created, INTERNAL_METADATA),
            ApiDenialReason.DATA_KEY_READ_DENIED,
            "read internal metadata"
        );

        ItemDataMutation.Set chargeEdit = new ItemDataMutation.Set(CHARGES, new IntegerDataValue(4));
        ItemStack edited = requireSuccess(api.editItem(created, List.of(chargeEdit)), "edit detached item");
        requireInteger(api.readItemData(created, CHARGES), 3, "source item remained immutable");
        requireInteger(api.readItemData(edited, CHARGES), 4, "read edited charges");
        expectDenied(
            api.editItem(edited, List.of(new ItemDataMutation.Set(CREATED_AT, new LongDataValue(1L)))),
            ApiDenialReason.DATA_KEY_WRITE_DENIED,
            "write internal-owned data"
        );

        MemoryPlayer memoryPlayer = new MemoryPlayer(edited);
        CompletionStage<ApiCallResult<BukkitSlotEditReceipt>> stage = api.editPlayerSlot(
            memoryPlayer.player(),
            BukkitPlayerSlot.MAIN_HAND,
            List.of(chargeEdit)
        );
        ApiCallResult<BukkitSlotEditReceipt> asyncResult = stage.toCompletableFuture().get(5, TimeUnit.SECONDS);
        BukkitSlotEditReceipt receipt = requireSuccess(asyncResult, "complete no-op slot edit");
        requireCondition(!receipt.getSemanticChanged(), "no-op slot edit reported a semantic change");
        requireCondition(memoryPlayer.playerId().equals(receipt.getPlayerId()), "slot receipt player changed");
        requireInteger(api.readItemData(memoryPlayer.mainHand(), CHARGES), 4, "read slot item after edit");

        return new ProbeReport(api.getCatalogRevision(), receipt.getCatalogRevision());
    }

    private static void requireInteger(
        ApiCallResult<? extends ItemDataValue> result,
        int expected,
        String operation
    ) {
        ItemDataValue value = requireSuccess(result, operation);
        if (!(value instanceof IntegerDataValue integer) || integer.getValue() != expected) {
            throw new ProbeFailure(operation + " returned " + value + " instead of " + expected);
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T requireSuccess(ApiCallResult<? extends T> result, String operation) {
        if (result instanceof ApiCallResult.Success<?> success) {
            return (T) success.getValue();
        }
        if (result instanceof ApiCallResult.Denied denied) {
            throw new ProbeFailure(operation + " denied with " + denied.getReason() + ": " + denied.getDetail());
        }
        throw new ProbeFailure(operation + " returned an unknown result type");
    }

    private static void expectDenied(
        ApiCallResult<?> result,
        ApiDenialReason expected,
        String operation
    ) {
        if (!(result instanceof ApiCallResult.Denied denied) || denied.getReason() != expected) {
            throw new ProbeFailure(operation + " did not return " + expected + ": " + result);
        }
    }

    private static void requireCondition(boolean condition, String detail) {
        if (!condition) {
            throw new ProbeFailure(detail);
        }
    }

    private void reportFailure(String phase, Throwable failure) {
        if (!reported.compareAndSet(false, true)) {
            return;
        }
        Throwable root = failure;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        String detail = String.valueOf(root.getMessage()).replace('\n', ' ').replace('\r', ' ');
        getLogger().severe(FAIL + " phase=" + phase + " type=" + root.getClass().getName() + " detail=" + detail);
        getLogger().log(java.util.logging.Level.SEVERE, "Itemerness runtime probe failure", failure);
    }

    private record ProbeReport(long catalogRevision, long asyncSlotRevision) {}

    private static final class ProbeFailure extends RuntimeException {
        private ProbeFailure(String message) {
            super(message);
        }
    }

    /** Minimal in-memory entity/inventory boundary for a no-op CompletionStage slot transaction. */
    private static final class MemoryPlayer {
        private final UUID playerId = UUID.randomUUID();
        private final AtomicReference<ItemStack> mainHand;
        private final Player player;

        private MemoryPlayer(ItemStack initial) {
            mainHand = new AtomicReference<>(initial.clone());
            PlayerInventory inventory = proxy(
                PlayerInventory.class,
                (object, method, arguments) -> inventoryCall(object, method, arguments, mainHand)
            );
            EntityScheduler scheduler = new DirectEntityScheduler();
            player = proxy(Player.class, (object, method, arguments) -> switch (method.getName()) {
                case "getUniqueId" -> playerId;
                case "getInventory" -> inventory;
                case "getScheduler" -> scheduler;
                case "getName" -> "ItemernessRuntimeProbe";
                case "isOnline" -> true;
                default -> objectCallOrDefault(object, method, arguments);
            });
        }

        private Player player() {
            return player;
        }

        private UUID playerId() {
            return playerId;
        }

        private ItemStack mainHand() {
            return mainHand.get();
        }

        private static Object inventoryCall(
            Object proxy,
            Method method,
            Object[] arguments,
            AtomicReference<ItemStack> mainHand
        ) {
            return switch (method.getName()) {
                case "getItemInMainHand" -> mainHand.get();
                case "setItemInMainHand" -> {
                    mainHand.set((ItemStack) arguments[0]);
                    yield null;
                }
                default -> objectCallOrDefault(proxy, method, arguments);
            };
        }
    }

    private static final class DirectEntityScheduler implements EntityScheduler {
        @Override
        public boolean execute(Plugin owner, Runnable action, Runnable retired, long delay) {
            action.run();
            return true;
        }

        @Override
        public ScheduledTask run(Plugin owner, Consumer<ScheduledTask> action, Runnable retired) {
            DirectScheduledTask task = new DirectScheduledTask(owner);
            action.accept(task);
            return task;
        }

        @Override
        public ScheduledTask runDelayed(
            Plugin owner,
            Consumer<ScheduledTask> action,
            Runnable retired,
            long delayTicks
        ) {
            throw new ProbeFailure("unexpected delayed entity scheduling");
        }

        @Override
        public ScheduledTask runAtFixedRate(
            Plugin owner,
            Consumer<ScheduledTask> action,
            Runnable retired,
            long initialDelayTicks,
            long periodTicks
        ) {
            throw new ProbeFailure("unexpected repeating entity scheduling");
        }
    }

    private record DirectScheduledTask(Plugin owningPlugin) implements ScheduledTask {
        @Override
        public Plugin getOwningPlugin() {
            return owningPlugin;
        }

        @Override
        public boolean isRepeatingTask() {
            return false;
        }

        @Override
        public CancelledState cancel() {
            return CancelledState.ALREADY_EXECUTED;
        }

        @Override
        public ExecutionState getExecutionState() {
            return ExecutionState.FINISHED;
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler);
    }

    private static Object objectCallOrDefault(Object proxy, Method method, Object[] arguments) {
        if (method.getDeclaringClass() == Object.class) {
            return switch (method.getName()) {
                case "toString" -> "ItemernessRuntimeProbe(" + proxy.getClass().getInterfaces()[0].getSimpleName() + ")";
                case "hashCode" -> System.identityHashCode(proxy);
                case "equals" -> proxy == arguments[0];
                default -> null;
            };
        }
        Class<?> type = method.getReturnType();
        if (!type.isPrimitive()) {
            if (Collection.class.isAssignableFrom(type)) {
                return List.of();
            }
            return null;
        }
        if (type == boolean.class) return false;
        if (type == char.class) return '\0';
        if (type == byte.class) return (byte) 0;
        if (type == short.class) return (short) 0;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == float.class) return 0.0F;
        if (type == double.class) return 0.0D;
        return null;
    }
}
