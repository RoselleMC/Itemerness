package com.iroselle.itemerness.api

import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.UUID

class BoundItemernessApiContractsTest {
    @Test
    fun `domain instances expose only opaque handle metadata`() {
        val instance = DomainItemInstance(
            handleId = UUID.fromString("00000000-0000-4000-8000-000000000099"),
            itemKey = ItemKey.parse("itemerness:test"),
            createdAgainstRevision = 4,
            instanceRevision = 0,
        )

        val publicProperties = DomainItemInstance::class.java.methods.map { it.name }.toSet()
        assertTrue("getHandleId" in publicProperties)
        assertTrue("getData" !in publicProperties)
        assertTrue("getSchemaVersions" !in publicProperties)
        assertTrue("getInstanceId" !in publicProperties)
        assertTrue("data=" !in instance.toString())
    }

    @Test
    fun `denial detail cannot be blank`() {
        assertThrows(IllegalArgumentException::class.java) {
            ApiCallResult.Denied(ApiDenialReason.ACTION_DENIED, " ")
        }
    }
}
