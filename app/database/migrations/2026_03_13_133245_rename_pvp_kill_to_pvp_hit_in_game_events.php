<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        DB::table('game_events')
            ->where('event_type', 'pvp_kill')
            ->update(['event_type' => 'pvp_hit']);
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::table('game_events')
            ->where('event_type', 'pvp_hit')
            ->update(['event_type' => 'pvp_kill']);
    }
};
