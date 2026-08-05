package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey

internal interface CommandCatalogView {
    fun itemKeys(): Collection<ItemKey>

    fun dataKeys(): Collection<DataKey>

    fun locales(): Collection<String>
}
