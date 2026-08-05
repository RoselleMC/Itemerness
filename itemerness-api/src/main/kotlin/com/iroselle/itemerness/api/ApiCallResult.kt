package com.iroselle.itemerness.api

/** A stable action that can be granted to a plugin-bound API caller. */
enum class ApiAction {
    IDENTIFY,
    CREATE,
    READ_DATA,
    EDIT_DATA,
    WRITE_VIEWER_FACT,
    REQUEST_REFRESH,
}

/** Machine-readable reasons for rejecting an API operation. */
enum class ApiDenialReason {
    CALLER_NOT_ACTIVE,
    ACTION_DENIED,
    ITEM_NOT_FOUND,
    DATA_KEY_NOT_FOUND,
    DATA_KEY_READ_DENIED,
    DATA_KEY_WRITE_DENIED,
    VIEWER_FACT_NOT_FOUND,
    VIEWER_FACT_WRITE_DENIED,
    OWNER_CONTEXT_REQUIRED,
    NOT_OWNER,
    DEFINITION_DATA_IMMUTABLE,
    INVALID_MANAGED_ITEM,
    INVALID_VALUE,
    CATALOG_CONFLICT,
    SLOT_CONFLICT,
    SLOT_QUEUE_FULL,
    PLATFORM_ACCESS_UNAVAILABLE,
    REFRESH_UNAVAILABLE,
}

/**
 * Result returned by an API boundary that performs caller authorization.
 *
 * A denial is an expected, typed outcome. Implementations should reserve exceptions for broken
 * invariants or malformed values that could not have passed the public type constructors.
 */
sealed interface ApiCallResult<out T> {
    data class Success<out T>(val value: T) : ApiCallResult<T>

    data class Denied(
        val reason: ApiDenialReason,
        val detail: String,
    ) : ApiCallResult<Nothing> {
        init {
            require(detail.isNotBlank()) { "API denial detail must not be blank" }
        }
    }
}
