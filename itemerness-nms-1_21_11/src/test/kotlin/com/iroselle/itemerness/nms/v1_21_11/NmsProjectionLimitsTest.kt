package com.iroselle.itemerness.nms.v1_21_11

import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class NmsProjectionLimitsTest {
    @Test
    fun `default packet budget accepts a full recipe-book sized item set`() {
        val budget = NmsPacketItemProjectionBudget()

        repeat(4_096) { budget.enterItem(depth = 0) }
    }

    @Test
    fun `default packet budget remains bounded`() {
        val budget = NmsPacketItemProjectionBudget()
        repeat(8_192) { budget.enterItem(depth = 0) }

        assertThrows(NmsRecoverableProjectionException::class.java) {
            budget.enterItem(depth = 0)
        }
    }
}
