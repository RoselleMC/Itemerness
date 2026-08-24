package com.iroselle.itemerness.nms.v26_2

import java.lang.reflect.Modifier
import java.lang.reflect.GenericArrayType
import java.lang.reflect.ParameterizedType
import java.lang.reflect.Type
import java.lang.reflect.WildcardType
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipFile
import net.minecraft.network.protocol.Packet
import net.minecraft.SharedConstants
import net.minecraft.server.Bootstrap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.component.DataComponentType
import net.minecraft.core.registries.BuiltInRegistries
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeAll
import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.FieldVisitor
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes

class NmsCarrierManifestTest {
    @Test
    fun `structured carrier ABI matches the mapped 26_2 contract`() {
        NmsStructuredCarrierAbi.verify()
    }

    @Test
    fun `mapped server packet graph and packaged carrier manifest stay in lockstep`() {
        val manifest = loadManifest()
        val discovered = discoverCarrierPackets()

        assertEquals(discovered, manifest.keys, buildString {
            appendLine("The exact 26.2 carrier manifest is stale.")
            appendLine("Missing: ${discovered - manifest.keys}")
            appendLine("Unexpected: ${manifest.keys - discovered}")
        })
        assertTrue(manifest.values.none { it.status == "unknown" })
    }

    @Test
    fun `item component carrier manifest matches implementation and exact registry ABI`() {
        val manifest = loadComponentManifest()
        val directItemIds = NmsItemComponentCarriers.DIRECT_ITEMS.mapTo(HashSet()) { it.id }
        val directComponentIds = NmsItemComponentCarriers.DIRECT_COMPONENTS.mapTo(HashSet()) { it.id }
        val implementation = NmsItemComponentCarriers.ALL.associate { carrier ->
            carrier.id to ComponentManifestEntry(
                strategy = when (carrier.id) {
                    in directItemIds -> "direct"
                    in directComponentIds -> "direct-component"
                    else -> "codec-graph"
                },
                surface = carrier.surface,
            )
        }

        assertEquals(implementation, manifest)
        assertEquals(discoverItemComponentCarriers(), manifest.keys, buildString {
            appendLine("The exact 26.2 item component carrier manifest is stale.")
            appendLine("Missing: ${discoverItemComponentCarriers() - manifest.keys}")
            appendLine("Unexpected: ${manifest.keys - discoverItemComponentCarriers()}")
        })
        assertEquals(NmsItemComponentCarriers.ALL.size, implementation.size)
        NmsItemComponentCarriers.ALL.forEach { carrier ->
            assertEquals(carrier.id, BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(carrier.type).toString())
            val declaration = DataComponents::class.java.declaredFields.single { field ->
                Modifier.isPublic(field.modifiers) &&
                    Modifier.isStatic(field.modifiers) &&
                    field.get(null) === carrier.type
            }
            assertTrue(Modifier.isPublic(declaration.modifiers), "${declaration.name} is no longer public")
        }
    }

    @Test
    fun `dynamic click and dialog action subtypes have an explicit exact-version policy`() {
        val classes = loadMappedClasses()
        val clickTypes = classes.keys.asSequence()
            .filter { name -> name.startsWith("net/minecraft/network/chat/ClickEvent\$") }
            .filter { name -> implementsType(name, CLICK_EVENT_TYPE, classes, HashSet()) }
            .map { name -> name.substringAfterLast('$') }
            .toSortedSet()
        val dialogActionTypes = classes.keys.asSequence()
            .filter { name ->
                name.startsWith("net/minecraft/server/dialog/action/") &&
                    '$' !in name &&
                    name != DIALOG_ACTION_TYPE
            }
            .filter { name -> implementsType(name, DIALOG_ACTION_TYPE, classes, HashSet()) }
            .map { name -> name.substringAfterLast('/') }
            .toSortedSet()

        assertEquals(PROJECTED_CLICK_ACTIONS + OPAQUE_CLICK_ACTIONS, clickTypes)
        assertEquals(setOf("Custom", "ShowDialog"), PROJECTED_CLICK_ACTIONS)
        assertEquals(PROJECTED_DIALOG_ACTIONS + OPAQUE_DIALOG_ACTIONS, dialogActionTypes)
        assertEquals(setOf("CustomAll", "StaticAction"), PROJECTED_DIALOG_ACTIONS)
    }

    @Test
    fun `all discovered carriers are implemented and the exact release gate is ready`() {
        val unsupported = loadManifest()
            .filterValues { entry -> entry.status == "unsupported-known" }
            .keys

        assertEquals(NmsProjectionReleaseGate.UNSUPPORTED_CARRIERS, unsupported)
        assertTrue(unsupported.isEmpty())
        assertTrue(NmsProjectionReleaseGate.SECURITY_BLOCKERS.isEmpty())
        assertTrue(NmsProjectionReleaseGate.ENABLED)
        NmsProjectionReleaseGate.requireReady()
    }

    @Test
    fun `release gate manifest and Bukkit surface metadata agree semantically`() {
        val unsupportedCarriers = loadManifest()
            .filterValues { entry -> entry.status == "unsupported-known" }
            .keys
        val surface = loadBukkitSurfaceMetadata()
        val enabled = surfaceScalar(surface, "release-gate-enabled").toBooleanStrict()
        val coverage = surfaceScalar(surface, "coverage-status")
        val knownUnsupportedEmpty = surfaceScalar(surface, "known-unsupported") == "[]"

        assertEquals(NmsProjectionReleaseGate.UNSUPPORTED_CARRIERS, unsupportedCarriers)
        assertEquals(NmsProjectionReleaseGate.ENABLED, enabled)
        assertEquals(
            if (enabled) "release-ready-exact-version" else "blocked-exact-version",
            coverage,
        )
        assertEquals(
            NmsProjectionReleaseGate.UNSUPPORTED_CARRIERS.isEmpty() &&
                NmsProjectionReleaseGate.SECURITY_BLOCKERS.isEmpty(),
            knownUnsupportedEmpty,
        )
    }

    @Test
    fun `viewer refresh explicitly reconstructs the open merchant offers packet`() {
        val calls = methodCalls(ProjectionChannelHandler::class.java, "refreshViewer")
        val merchantOwner = "net/minecraft/world/inventory/MerchantMenu"
        setOf("getOffers", "getTraderLevel", "getTraderXp", "showProgressBar", "canRestock")
            .forEach { method ->
                assertTrue(MethodCall(merchantOwner, method) in calls, "Missing MerchantMenu.$method refresh call")
            }
        assertTrue(
            MethodCall("net/minecraft/network/protocol/game/ClientboundMerchantOffersPacket", "<init>") in calls,
            "Viewer refresh no longer reconstructs ClientboundMerchantOffersPacket",
        )
        assertTrue(
            MethodCall("net/minecraft/network/Connection", "send") in calls,
            "Viewer refresh no longer sends the reconstructed merchant offers packet",
        )
    }

    @Test
    fun `viewer refresh reconstructs authoritative recipe book recipe registry and advancements`() {
        val calls = methodCalls(ProjectionChannelHandler::class.java, "refreshViewer")
        setOf(
            MethodCall("net/minecraft/server/MinecraftServer", "getRecipeManager"),
            MethodCall(
                "net/minecraft/world/item/crafting/RecipeManager",
                "getSynchronizedItemProperties",
            ),
            MethodCall(
                "net/minecraft/world/item/crafting/RecipeManager",
                "getSynchronizedStonecutterRecipes",
            ),
            MethodCall("net/minecraft/network/protocol/game/ClientboundUpdateRecipesPacket", "<init>"),
            MethodCall("net/minecraft/stats/ServerRecipeBook", "sendInitialRecipeBook"),
            MethodCall("net/minecraft/server/PlayerAdvancements", "flushDirty"),
            MethodCall(
                "com/iroselle/itemerness/nms/v26_2/NmsPlayerAdvancementsAccess",
                "fullSnapshot",
            ),
        ).forEach { required ->
            assertTrue(required in calls, "Missing authoritative persistent refresh call: $required")
        }
    }

    private fun discoverCarrierPackets(): Set<String> {
        val classes = loadMappedClasses()
        return classes.values.asSequence()
            .filter { metadata ->
                '$' !in metadata.name &&
                    metadata.name.substringAfterLast('/').startsWith("Clientbound") &&
                    metadata.name.startsWith(PROTOCOL_PACKAGE)
            }
            .filter { metadata -> isPacket(metadata.name, classes, HashSet()) }
            .filter { metadata -> reachesCarrier(metadata.name, classes, HashSet()) }
            .map { metadata -> metadata.name.replace('/', '.') }
            .toSortedSet()
    }

    private fun loadMappedClasses(): Map<String, ClassMetadata> {
        val location = Path.of(Packet::class.java.protectionDomain.codeSource.location.toURI())
        check(Files.isRegularFile(location)) { "Mapped server classes are not loaded from a JAR: $location" }
        ZipFile(location.toFile()).use { jar ->
            return jar.entries().asSequence()
                .filter { entry -> entry.name.startsWith("net/minecraft/") && entry.name.endsWith(".class") }
                .associate { entry ->
                    jar.getInputStream(entry).use { input ->
                        val metadata = ClassMetadata.read(input.readAllBytes())
                        metadata.name to metadata
                    }
                }
        }
    }

    private fun discoverItemComponentCarriers(): Set<String> {
        val classes = loadMappedClasses()
        return DataComponents::class.java.declaredFields.asSequence()
            .filter { field ->
                Modifier.isPublic(field.modifiers) &&
                    Modifier.isStatic(field.modifiers) &&
                    DataComponentType::class.java.isAssignableFrom(field.type)
            }
            .filter { field ->
                typeNames(field.genericType).any { type ->
                    reachesItemComponentCarrier(type, classes, HashSet())
                }
            }
            .map { field ->
                val type = field.get(null) as DataComponentType<*>
                BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type).toString()
            }
            .toSortedSet()
    }

    private fun typeNames(type: Type): Set<String> = when (type) {
        is Class<*> -> setOf(type.name.replace('.', '/'))
        is ParameterizedType -> buildSet {
            addAll(typeNames(type.rawType))
            type.actualTypeArguments.forEach { argument -> addAll(typeNames(argument)) }
        }
        is WildcardType -> (type.upperBounds + type.lowerBounds).flatMapTo(LinkedHashSet(), ::typeNames)
        is GenericArrayType -> typeNames(type.genericComponentType)
        else -> emptySet()
    }

    private fun reachesItemComponentCarrier(
        className: String,
        classes: Map<String, ClassMetadata>,
        visited: MutableSet<String>,
    ): Boolean {
        if (className in ITEM_COMPONENT_CARRIER_TYPES || className in DYNAMIC_ITEM_COMPONENT_TYPES) return true
        if (className in ITEM_COMPONENT_OPAQUE_TYPES) return false
        if (!className.startsWith("net/minecraft/") || !visited.add(className)) return false
        val metadata = classes[className] ?: return false
        return metadata.superName?.let { reachesItemComponentCarrier(it, classes, visited) } == true ||
            metadata.fieldTypes.any { type -> reachesItemComponentCarrier(type, classes, visited) }
    }

    private fun reachesCarrier(
        className: String,
        classes: Map<String, ClassMetadata>,
        visited: MutableSet<String>,
    ): Boolean {
        if (className in CARRIER_TYPES) return true
        if (className in OPAQUE_WIRE_VALUE_TYPES) return false
        if (!className.startsWith("net/minecraft/") || !visited.add(className)) return false
        val metadata = classes[className] ?: return false
        return metadata.superName?.let { reachesCarrier(it, classes, visited) } == true ||
            metadata.fieldTypes.any { type -> reachesCarrier(type, classes, visited) }
    }

    private fun isPacket(
        className: String,
        classes: Map<String, ClassMetadata>,
        visited: MutableSet<String>,
    ): Boolean {
        if (className == "net/minecraft/network/protocol/Packet") return true
        if (!visited.add(className)) return false
        val metadata = classes[className] ?: return false
        return metadata.interfaces.any { type -> isPacket(type, classes, visited) } ||
            metadata.superName?.let { type -> isPacket(type, classes, visited) } == true
    }

    private fun implementsType(
        className: String,
        target: String,
        classes: Map<String, ClassMetadata>,
        visited: MutableSet<String>,
    ): Boolean {
        if (className == target) return true
        if (!visited.add(className)) return false
        val metadata = classes[className] ?: return false
        return metadata.interfaces.any { type -> implementsType(type, target, classes, visited) } ||
            metadata.superName?.let { type -> implementsType(type, target, classes, visited) } == true
    }

    private fun loadManifest(): Map<String, ManifestEntry> {
        val stream = requireNotNull(javaClass.getResourceAsStream(MANIFEST_RESOURCE)) {
            "Missing carrier manifest: $MANIFEST_RESOURCE"
        }
        return stream.bufferedReader().useLines { lines ->
            lines.drop(1)
                .filter(String::isNotBlank)
                .map { line ->
                    val columns = line.split('\t')
                    check(columns.size == 3) { "Malformed carrier manifest line: $line" }
                    columns[1] to ManifestEntry(columns[0], columns[2])
                }
                .toMap()
        }
    }

    private fun loadComponentManifest(): Map<String, ComponentManifestEntry> {
        val stream = requireNotNull(javaClass.getResourceAsStream(COMPONENT_MANIFEST_RESOURCE)) {
            "Missing item component carrier manifest: $COMPONENT_MANIFEST_RESOURCE"
        }
        return stream.bufferedReader().useLines { lines ->
            lines.drop(1)
                .filter(String::isNotBlank)
                .map { line ->
                    val columns = line.split('\t')
                    check(columns.size == 3) { "Malformed item component manifest line: $line" }
                    columns[1] to ComponentManifestEntry(columns[0], columns[2])
                }
                .toMap()
        }
    }

    private fun loadBukkitSurfaceMetadata(): String {
        var current = Path.of("").toAbsolutePath().normalize()
        repeat(8) {
            val candidate = current.resolve(BUKKIT_SURFACE_PATH)
            if (Files.isRegularFile(candidate)) return Files.readString(candidate)
            current = current.parent ?: error("Cannot locate repository root from ${Path.of("").toAbsolutePath()}")
        }
        error("Missing Bukkit exact-version surface metadata: $BUKKIT_SURFACE_PATH")
    }

    private fun surfaceScalar(source: String, key: String): String = requireNotNull(
        Regex("^${Regex.escape(key)}:\\s*(.+?)\\s*$", RegexOption.MULTILINE).find(source),
    ) { "Missing surface metadata key: $key" }.groupValues[1]

    private fun methodCalls(type: Class<*>, methodName: String): Set<MethodCall> {
        val resource = "/${type.name.replace('.', '/')}.class"
        val bytes = requireNotNull(type.getResourceAsStream(resource)) { "Missing class bytes: $resource" }
            .use { stream -> stream.readAllBytes() }
        val calls = LinkedHashSet<MethodCall>()
        ClassReader(bytes).accept(object : ClassVisitor(Opcodes.ASM9) {
            override fun visitMethod(
                access: Int,
                name: String,
                descriptor: String,
                signature: String?,
                exceptions: Array<out String>?,
            ): MethodVisitor? {
                if (name != methodName) return null
                return object : MethodVisitor(Opcodes.ASM9) {
                    override fun visitMethodInsn(
                        opcode: Int,
                        owner: String,
                        name: String,
                        descriptor: String,
                        isInterface: Boolean,
                    ) {
                        calls += MethodCall(owner, name)
                    }
                }
            }
        }, ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES)
        return calls
    }

    private data class ManifestEntry(
        val status: String,
        val surface: String,
    )

    private data class ComponentManifestEntry(
        val strategy: String,
        val surface: String,
    )

    private data class MethodCall(
        val owner: String,
        val name: String,
    )

    private data class ClassMetadata(
        val name: String,
        val superName: String?,
        val interfaces: Set<String>,
        val fieldTypes: Set<String>,
    ) {
        companion object {
            fun read(bytes: ByteArray): ClassMetadata {
                var name = ""
                var superName: String? = null
                val implementedInterfaces = LinkedHashSet<String>()
                val fieldTypes = LinkedHashSet<String>()
                ClassReader(bytes).accept(object : ClassVisitor(Opcodes.ASM9) {
                    override fun visit(
                        version: Int,
                        access: Int,
                        className: String,
                        signature: String?,
                        parentName: String?,
                        interfaceNames: Array<out String>?,
                    ) {
                        name = className
                        superName = parentName
                        if (interfaceNames != null) {
                            implementedInterfaces += interfaceNames
                        }
                    }

                    override fun visitField(
                        access: Int,
                        fieldName: String,
                        descriptor: String,
                        signature: String?,
                        value: Any?,
                    ): FieldVisitor? {
                        if (!Modifier.isStatic(access)) {
                            TYPE_PATTERN.findAll(descriptor).forEach { match -> fieldTypes += match.groupValues[1] }
                            if (signature != null) {
                                TYPE_PATTERN.findAll(signature).forEach { match -> fieldTypes += match.groupValues[1] }
                            }
                        }
                        return null
                    }
                }, ClassReader.SKIP_CODE or ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES)
                return ClassMetadata(name, superName, implementedInterfaces, fieldTypes)
            }
        }
    }

    private companion object {
        const val MANIFEST_RESOURCE = "/META-INF/itemerness/nms/26.2/carrier-surfaces.tsv"
        const val COMPONENT_MANIFEST_RESOURCE =
            "/META-INF/itemerness/nms/26.2/item-component-surfaces.tsv"
        const val BUKKIT_SURFACE_PATH =
            "itemerness-bukkit/src/main/resources/META-INF/itemerness/nms/26.2/surfaces.yml"
        const val PROTOCOL_PACKAGE = "net/minecraft/network/protocol/"
        const val CLICK_EVENT_TYPE = "net/minecraft/network/chat/ClickEvent"
        const val DIALOG_ACTION_TYPE = "net/minecraft/server/dialog/action/Action"
        val PROJECTED_CLICK_ACTIONS = setOf("Custom", "ShowDialog")
        val OPAQUE_CLICK_ACTIONS = setOf(
            "ChangePage",
            "CopyToClipboard",
            "OpenFile",
            "OpenUrl",
            "RunCommand",
            "SuggestCommand",
        )
        val PROJECTED_DIALOG_ACTIONS = setOf("CustomAll", "StaticAction")
        val OPAQUE_DIALOG_ACTIONS = setOf("CommandTemplate")
        val TYPE_PATTERN = Regex("L([^;<]+)")
        val CARRIER_TYPES = setOf(
            "net/minecraft/advancements/AdvancementHolder",
            "net/minecraft/nbt/Tag",
            "net/minecraft/network/chat/Component",
            "net/minecraft/network/chat/numbers/NumberFormat",
            "net/minecraft/network/protocol/BundlePacket",
            "net/minecraft/network/protocol/game/ClientboundBossEventPacket\$Operation",
            "net/minecraft/network/syncher/SynchedEntityData\$DataValue",
            "net/minecraft/core/particles/ParticleOptions",
            "net/minecraft/server/dialog/Dialog",
            "net/minecraft/world/item/ItemStack",
            "net/minecraft/world/item/ItemStackTemplate",
            "net/minecraft/world/item/crafting/display/RecipeDisplay",
            "net/minecraft/world/item/crafting/display/SlotDisplay",
            "net/minecraft/world/item/trading/MerchantOffers",
        )
        // These values are encoded as ids, enum ordinals, keys, or fixed coordinates. Walking their
        // implementation graph would inspect server-side behavior that never crosses the wire.
        val OPAQUE_WIRE_VALUE_TYPES = setOf(
            "net/minecraft/commands/arguments/EntityAnchorArgument\$Anchor",
            "net/minecraft/core/GlobalPos",
            "net/minecraft/core/Holder",
            "net/minecraft/resources/ResourceKey",
            "net/minecraft/stats/Stat",
            "net/minecraft/world/effect/MobEffect",
            "net/minecraft/world/entity/EntityType",
            "net/minecraft/world/level/Level",
            "net/minecraft/world/level/GameType",
            "net/minecraft/world/level/block/Block",
            "net/minecraft/world/level/dimension/DimensionType",
        )
        val ITEM_COMPONENT_CARRIER_TYPES = setOf(
            "net/minecraft/core/component/DataComponentMap",
            "net/minecraft/core/component/DataComponentPatch",
            "net/minecraft/nbt/CompoundTag",
            "net/minecraft/network/chat/Component",
            "net/minecraft/world/item/ItemStack",
            "net/minecraft/world/item/ItemStackTemplate",
        )
        // These codecs select a value subtype or a component predicate through a registry-backed
        // discriminator. That reachable state is not represented by an instance-field edge in the
        // class file, so the bytecode graph needs an explicit exact-version root.
        val DYNAMIC_ITEM_COMPONENT_TYPES = setOf(
            "net/minecraft/world/LockCode",
            "net/minecraft/world/item/component/ItemAttributeModifiers",
        )
        val ITEM_COMPONENT_OPAQUE_TYPES = setOf(
            "net/minecraft/core/Holder",
            "net/minecraft/core/HolderSet",
            "net/minecraft/core/Registry",
            "net/minecraft/core/component/DataComponentType",
            "net/minecraft/resources/Identifier",
            "net/minecraft/resources/ResourceKey",
            "net/minecraft/world/item/Item",
            "net/minecraft/world/level/block/Block",
            "net/minecraft/world/entity/EntityType",
            "net/minecraft/world/level/block/entity/BlockEntityType",
        )

        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
        }
    }
}
