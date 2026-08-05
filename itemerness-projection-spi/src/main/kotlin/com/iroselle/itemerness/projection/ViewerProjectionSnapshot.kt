package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey
import java.util.UUID

data class LocaleId(
    val value: String,
) {
    init {
        require(PATTERN.matches(value)) { "Invalid locale id: $value" }
    }

    companion object {
        private val PATTERN = Regex("[a-z0-9_-]{2,64}")
    }
}

data class ViewerFact(
    val key: ItemKey,
    val value: ProjectionValue,
)

/** Viewer-owned data captured before work reaches a packet event loop. */
class ViewerProjectionSnapshot(
    val viewerId: UUID,
    val revision: Long,
    /** Catalog revision against which locale, facts, profile, and capabilities were resolved. */
    val catalogRevision: Long = 0,
    val locale: LocaleId,
    /** Optional viewer override. Null delegates theme selection to each item presentation. */
    val theme: ItemKey?,
    val assetProfile: ItemKey?,
    facts: Collection<ViewerFact> = emptyList(),
    capabilities: Collection<ItemKey> = emptyList(),
) {
    val facts: List<ViewerFact> = java.util.List.copyOf(
        facts.sortedBy { fact -> fact.key.toString() },
    )
    val capabilities: List<ItemKey> = java.util.List.copyOf(
        capabilities.sortedBy(ItemKey::toString),
    )

    init {
        require(revision >= 0) { "Viewer snapshot revision must not be negative" }
        require(catalogRevision >= 0) { "Viewer catalog revision must not be negative" }
        require(this.facts.size <= MAX_FACTS) {
            "Viewer snapshots must not exceed $MAX_FACTS facts"
        }
        require(this.capabilities.size <= MAX_CAPABILITIES) {
            "Viewer snapshots must not exceed $MAX_CAPABILITIES capabilities"
        }
        require(this.facts.mapTo(HashSet()) { it.key }.size == this.facts.size) {
            "Viewer fact keys must be unique"
        }
        require(this.capabilities.toHashSet().size == this.capabilities.size) {
            "Viewer capabilities must be unique"
        }
    }

    fun fact(key: ItemKey): ProjectionValue? = facts.firstOrNull { it.key == key }?.value

    fun hasCapability(capability: ItemKey): Boolean = capability in capabilities

    override fun equals(other: Any?): Boolean =
        this === other ||
            other is ViewerProjectionSnapshot &&
            viewerId == other.viewerId &&
            revision == other.revision &&
            catalogRevision == other.catalogRevision &&
            locale == other.locale &&
            theme == other.theme &&
            assetProfile == other.assetProfile &&
            facts == other.facts &&
            capabilities == other.capabilities

    override fun hashCode(): Int {
        var result = viewerId.hashCode()
        result = 31 * result + revision.hashCode()
        result = 31 * result + catalogRevision.hashCode()
        result = 31 * result + locale.hashCode()
        result = 31 * result + theme.hashCode()
        result = 31 * result + (assetProfile?.hashCode() ?: 0)
        result = 31 * result + facts.hashCode()
        result = 31 * result + capabilities.hashCode()
        return result
    }

    override fun toString(): String =
        "ViewerProjectionSnapshot(viewerId=$viewerId, revision=$revision, " +
            "catalogRevision=$catalogRevision, locale=$locale, " +
            "theme=$theme, assetProfile=$assetProfile, facts=$facts, capabilities=$capabilities)"

    private companion object {
        const val MAX_FACTS = 256
        const val MAX_CAPABILITIES = 128
    }
}
